// src/runCandidate.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCandidate, type RunCandidateDeps } from "./runCandidate.ts";
import type { AttemptOutcome } from "./launch.ts";
import type { PiRunOutcome } from "./pi-events.ts";
import type { Reachability } from "./reachability.ts";

function outcome(o: Partial<PiRunOutcome>, extra: Partial<AttemptOutcome> = {}): AttemptOutcome {
  // terminalText defaults to `text` (the common case where the terminal block carries the final
  // answer). The split-block test overrides terminalText explicitly to exercise finding E.
  const oc: PiRunOutcome = { text: "", terminalText: "", sawAssistantOutput: false, ...o };
  if (o.terminalText === undefined) oc.terminalText = oc.text;
  return {
    outcome: oc,
    startupTimedOut: false, overallTimedOut: false, idledOut: false,
    exitCode: 0, signal: null, stderr: "", ...extra,
  };
}

// Scripts a sequence of launch outcomes (one per launch call) and records the requests.
function scriptedLaunch(seq: AttemptOutcome[], reqs: { prompt: string; continueSession: boolean }[]) {
  let i = 0;
  return (req: { prompt: string; continueSession: boolean }) => {
    reqs.push(req);
    return Promise.resolve(seq[i++] ?? seq[seq.length - 1]);
  };
}

function baseDeps(over: Partial<RunCandidateDeps> = {}): RunCandidateDeps {
  return {
    launch: () => Promise.resolve(outcome({ stopReason: "stop", text: "X", sawAssistantOutput: true })),
    probe: () => Promise.resolve("up" as Reachability),
    sleep: () => Promise.resolve(),
    sessionReady: () => true,
    warn: () => {},
    ...over,
  };
}

const ctx = { prompt: "do it", nonceEnabled: true, resumeAttempts: 1 };

test("nonce present on first try -> success, sentinel stripped, suffix injected", async () => {
  const reqs: { prompt: string; continueSession: boolean }[] = [];
  // We do not know the minted nonce; the launch echoes whatever nonce the suffix carried.
  const launch: RunCandidateDeps["launch"] = (req) => {
    reqs.push(req);
    const m = /WORK COMPLETE ([0-9a-f]{16})/.exec(req.prompt);
    const nonce = m ? m[1] : "";
    return Promise.resolve(outcome({ stopReason: "stop", text: `answer\nWORK COMPLETE ${nonce}`, sawAssistantOutput: true }));
  };
  const r = await runCandidate(ctx, baseDeps({ launch }));
  assert.equal(r.kind, "success");
  assert.equal(r.kind === "success" && r.text, "answer");
  assert.equal(reqs[0].continueSession, false);
  assert.match(reqs[0].prompt, /do it/);
  assert.match(reqs[0].prompt, /WORK COMPLETE [0-9a-f]{16}/);
});

test("nonce missing then present on resume -> success on the 2nd attempt", async () => {
  const reqs: { prompt: string; continueSession: boolean }[] = [];
  let n = 0;
  const launch: RunCandidateDeps["launch"] = (req) => {
    reqs.push(req);
    const nonce = (/WORK COMPLETE ([0-9a-f]{16})/.exec(req.prompt) ?? [])[1] ?? "";
    n += 1;
    return Promise.resolve(
      n === 1
        ? outcome({ stopReason: "stop", text: "partial, not done", sawAssistantOutput: true })
        : outcome({ stopReason: "stop", text: `done\nWORK COMPLETE ${nonce}`, sawAssistantOutput: true }),
    );
  };
  const r = await runCandidate(ctx, baseDeps({ launch }));
  assert.equal(r.kind, "success");
  assert.equal(r.kind === "success" && r.text, "done"); // D11: sentinel stripped on the resume path too
  assert.equal(reqs.length, 2);
  assert.equal(reqs[1].continueSession, true);
});

test("resume budget exhausted -> incomplete with partial text, exit-1 semantics", async () => {
  const launch: RunCandidateDeps["launch"] = () =>
    Promise.resolve(outcome({ stopReason: "stop", text: "still not done", sawAssistantOutput: true }));
  const r = await runCandidate({ ...ctx, resumeAttempts: 1 }, baseDeps({ launch }));
  assert.equal(r.kind, "incomplete");
  assert.equal(r.kind === "incomplete" && r.text, "still not done");
});

test("pre-output idle stall + probe up -> failover (ambiguous)", async () => {
  const launch: RunCandidateDeps["launch"] = () =>
    Promise.resolve(outcome({}, { idledOut: true }));
  const r = await runCandidate(ctx, baseDeps({ launch }));
  assert.equal(r.kind, "failover");
  assert.equal(r.kind === "failover" && r.verdict.kind, "ambiguous");
});

// FIX C: post-output incomplete with no resumable session is a TERMINAL partial (emit + banner + exit 1),
// NOT a failover to the next model (which would run another model over the first's side-effects).
test("session not ready -> incomplete (partial), never failover", async () => {
  const launch: RunCandidateDeps["launch"] = () =>
    Promise.resolve(outcome({ stopReason: "stop", text: "no nonce", sawAssistantOutput: true }));
  const r = await runCandidate(ctx, baseDeps({ launch, sessionReady: () => false }));
  assert.equal(r.kind, "incomplete");
  assert.ok(r.kind === "incomplete" && /no resumable session on disk/.test(r.message)); // routed via resumeOrTerminal (Fix C), not the outage helper
});

// FIX B: outage-recovery after post-output must NOT blindly --continue when no session exists.
test("outage recovery, post-output, no session -> incomplete (not a blind --continue)", async () => {
  let launches = 0;
  let probes = 0;
  const launch: RunCandidateDeps["launch"] = (req) => {
    launches += 1;
    // attempt 1: produced output then idle-killed; there is never a resumable session on disk.
    return Promise.resolve(outcome({ text: "partial work", sawAssistantOutput: true }, { idledOut: true }));
  };
  const probe = () => Promise.resolve<Reachability>(probes++ === 0 ? "down" : "up");
  const r = await runCandidate(ctx, baseDeps({
    launch, probe, sleep: () => Promise.resolve(), sessionReady: () => false,
  }));
  assert.equal(r.kind, "incomplete");   // recovered from outage, but cannot resume -> partial
  assert.ok(r.kind === "incomplete" && /after outage/.test(r.message)); // routed via the outage helper (Fix B), not resumeOrTerminal
  assert.equal(launches, 1);            // did NOT relaunch with --continue into an empty session
});

test("bad key surfaces as inference 401 -> fatal, no probe (AR-2: auth is a classify verdict, not a probe state)", async () => {
  // Spike AR-2: the /models probe is public and cannot see auth; a bad key is detected only when the
  // inference returns 401, which classify maps to fatal (branch 6). A clean 401 proves the API is
  // reachable, so no outage probe fires.
  let probed = false;
  const launch: RunCandidateDeps["launch"] = () =>
    Promise.resolve(outcome({ stopReason: "error", errorMessage: '401: {"type":"invalid_api_key"}', sawAssistantOutput: false }));
  const r = await runCandidate(ctx, baseDeps({
    launch,
    probe: () => { probed = true; return Promise.resolve<Reachability>("up"); },
  }));
  assert.equal(r.kind, "fatal");
  assert.equal(probed, false);
});

test("probe down-then-up during resume: retries same candidate, no failover, pausedMs>0", async () => {
  let probes = 0;
  const probe = () => Promise.resolve<Reachability>(probes++ === 0 ? "down" : "up");
  const slept: number[] = [];
  let n = 0;
  const launch: RunCandidateDeps["launch"] = (req) => {
    const nonce = (/WORK COMPLETE ([0-9a-f]{16})/.exec(req.prompt) ?? [])[1] ?? "";
    n += 1;
    return Promise.resolve(
      n === 1
        ? outcome({ stopReason: "stop", text: "not done", sawAssistantOutput: true })
        : outcome({ stopReason: "stop", text: `WORK COMPLETE ${nonce}`, sawAssistantOutput: true }),
    );
  };
  const r = await runCandidate(ctx, baseDeps({ launch, probe, sleep: (ms) => { slept.push(ms); return Promise.resolve(); } }));
  assert.equal(r.kind, "success");
  assert.equal(r.pausedMs, 1000); // exactly one backoff rung walked (not just > 0)
  assert.deepEqual(slept, [1000]); // recovered after the first 1s rung
});

test("probe down to the cap -> transient (exit 1), ladder is 1,2,4,...,1024s", async () => {
  const slept: number[] = [];
  const launch: RunCandidateDeps["launch"] = () =>
    Promise.resolve(outcome({ stopReason: "stop", text: "not done", sawAssistantOutput: true }));
  const r = await runCandidate(ctx, baseDeps({
    launch,
    probe: () => Promise.resolve("down"),
    sleep: (ms) => { slept.push(ms); return Promise.resolve(); },
  }));
  assert.equal(r.kind, "transient");
  assert.deepEqual(slept, [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 512000, 1024000]);
});

test("nonce disabled: clean stop -> success (no resume, Spec B parity)", async () => {
  const launch: RunCandidateDeps["launch"] = () =>
    Promise.resolve(outcome({ stopReason: "stop", text: "answer", sawAssistantOutput: true }));
  const r = await runCandidate({ ...ctx, nonceEnabled: false }, baseDeps({ launch }));
  assert.equal(r.kind, "success");
  assert.equal(r.kind === "success" && r.text, "answer");
});

test("clean model-unavailable (no output) -> failover, no probe", async () => {
  let probed = false;
  const launch: RunCandidateDeps["launch"] = () =>
    Promise.resolve(outcome({ stopReason: "error", model: "m", errorMessage: "404 not_found_error" }));
  const r = await runCandidate(ctx, baseDeps({ launch, probe: () => { probed = true; return Promise.resolve("up"); } }));
  assert.equal(r.kind, "failover");
  assert.equal(probed, false);
});

test("post-output hard error -> fatal (exit-1, no failover)", async () => {
  const launch: RunCandidateDeps["launch"] = () =>
    Promise.resolve(outcome({ stopReason: "error", model: "m", errorMessage: "400 Model m not supported", sawAssistantOutput: true }));
  const r = await runCandidate(ctx, baseDeps({ launch }));
  assert.equal(r.kind, "fatal");
});

// D8 (anti-cascade headline): an idle stall during an outage must BACK OFF, not fail over.
test("idle stall + probe down-then-up -> backs off and retries the SAME candidate, never failover", async () => {
  let probes = 0;
  const probe = () => Promise.resolve<Reachability>(probes++ === 0 ? "down" : "up");
  const slept: number[] = [];
  let n = 0;
  const launch: RunCandidateDeps["launch"] = (req) => {
    const nonce = (/WORK COMPLETE ([0-9a-f]{16})/.exec(req.prompt) ?? [])[1] ?? "";
    n += 1;
    return Promise.resolve(
      n === 1
        ? outcome({}, { idledOut: true }) // pre-output idle, no terminal
        : outcome({ stopReason: "stop", text: `WORK COMPLETE ${nonce}`, sawAssistantOutput: true }),
    );
  };
  const r = await runCandidate(ctx, baseDeps({ launch, probe, sleep: (ms) => { slept.push(ms); return Promise.resolve(); } }));
  assert.equal(r.kind, "success");   // recovered -> fresh relaunch succeeded; NOT failover
  assert.equal(r.pausedMs, 1000); // exactly one backoff rung walked (not just > 0)
  assert.deepEqual(slept, [1000]);
});

// AR-1: a network outage surfaces as an ambiguous "Connection error." (no HTTP status). It must be
// PROBED and waited out (retry the same candidate), never failed over as if it were a clean ambiguous.
test("ambiguous connection-error + probe down-then-up -> backs off, retries SAME candidate, success", async () => {
  let probes = 0;
  const probe = () => Promise.resolve<Reachability>(probes++ === 0 ? "down" : "up");
  const slept: number[] = [];
  const reqs: { prompt: string; continueSession: boolean }[] = [];
  let n = 0;
  const launch: RunCandidateDeps["launch"] = (req) => {
    reqs.push(req);
    const nonce = (/WORK COMPLETE ([0-9a-f]{16})/.exec(req.prompt) ?? [])[1] ?? "";
    n += 1;
    return Promise.resolve(
      n === 1
        ? outcome({ stopReason: "error", errorMessage: "Connection error.", sawAssistantOutput: false })
        : outcome({ stopReason: "stop", text: `done\nWORK COMPLETE ${nonce}`, sawAssistantOutput: true }),
    );
  };
  const r = await runCandidate(ctx, baseDeps({ launch, probe, sleep: (ms) => { slept.push(ms); return Promise.resolve(); } }));
  assert.equal(r.kind, "success");        // outage waited out + retried, NOT failover
  assert.equal(n, 2);                     // relaunched the SAME candidate after recovery
  assert.equal(reqs[1].continueSession, false); // fresh relaunch (no output was produced), not --continue
  assert.deepEqual(slept, [1000]);        // exactly one backoff rung
});

// AR-1 converse: an ambiguous verdict when the API is genuinely UP (a truncated/inconclusive stream,
// not an outage) still fails over — the probe distinguishes the two.
test("ambiguous + probe up -> failover (genuine ambiguity, not an outage)", async () => {
  let probes = 0;
  const launch: RunCandidateDeps["launch"] = () =>
    Promise.resolve(outcome({ stopReason: "error", errorMessage: "Connection error.", sawAssistantOutput: false }));
  const r = await runCandidate(ctx, baseDeps({ launch, probe: () => { probes += 1; return Promise.resolve<Reachability>("up"); } }));
  assert.equal(r.kind, "failover");
  assert.equal(r.kind === "failover" && r.verdict.kind, "ambiguous");
  assert.equal(probes, 1);                // probed once, API up -> straight to failover
});

// D8: post-output idle stall (row 3) unifies with the nonce-miss resume path.
test("post-output idle stall + probe up -> resume -> success", async () => {
  const reqs: { prompt: string; continueSession: boolean }[] = [];
  let n = 0;
  const launch: RunCandidateDeps["launch"] = (req) => {
    reqs.push(req);
    const nonce = (/WORK COMPLETE ([0-9a-f]{16})/.exec(req.prompt) ?? [])[1] ?? "";
    n += 1;
    return Promise.resolve(
      n === 1
        ? outcome({ text: "THINKING", sawAssistantOutput: true }, { idledOut: true }) // stalled after output, no terminal
        : outcome({ stopReason: "stop", text: `done\nWORK COMPLETE ${nonce}`, sawAssistantOutput: true }),
    );
  };
  const r = await runCandidate(ctx, baseDeps({ launch }));
  assert.equal(r.kind, "success");
  assert.equal(reqs[1].continueSession, true); // resumed the same candidate
});

// D4: a post-output TRANSIENT during a real outage waits it out, then retries — NOT an immediate exit 1.
test("post-output transient + probe down-then-up -> waits out the outage, retries, success", async () => {
  let probes = 0;
  const probe = () => Promise.resolve<Reachability>(probes++ === 0 ? "down" : "up");
  const slept: number[] = [];
  let n = 0;
  const launch: RunCandidateDeps["launch"] = (req) => {
    const nonce = (/WORK COMPLETE ([0-9a-f]{16})/.exec(req.prompt) ?? [])[1] ?? "";
    n += 1;
    return Promise.resolve(
      n === 1
        ? outcome({ stopReason: "error", errorMessage: "503 service_unavailable", text: "partial", sawAssistantOutput: true })
        : outcome({ stopReason: "stop", text: `done\nWORK COMPLETE ${nonce}`, sawAssistantOutput: true }),
    );
  };
  const r = await runCandidate(ctx, baseDeps({ launch, probe, sleep: (ms) => { slept.push(ms); return Promise.resolve(); } }));
  assert.equal(r.kind, "success");
  assert.equal(r.pausedMs, 1000); // exactly one backoff rung walked (not just > 0)
  assert.deepEqual(slept, [1000]);
});

// D6: a 429 (throttled) probe enters the backoff ladder like down, but on recovery retries.
test("throttled (429) probe then up -> backs off then retries", async () => {
  let probes = 0;
  const probe = () => Promise.resolve<Reachability>(probes++ === 0 ? "throttled" : "up");
  const slept: number[] = [];
  let n = 0;
  const launch: RunCandidateDeps["launch"] = (req) => {
    const nonce = (/WORK COMPLETE ([0-9a-f]{16})/.exec(req.prompt) ?? [])[1] ?? "";
    n += 1;
    return n === 1
      ? Promise.resolve(outcome({ stopReason: "stop", text: "not done", sawAssistantOutput: true }))
      : Promise.resolve(outcome({ stopReason: "stop", text: `WORK COMPLETE ${nonce}`, sawAssistantOutput: true }));
  };
  const r = await runCandidate(ctx, baseDeps({ launch, probe, sleep: (ms) => { slept.push(ms); return Promise.resolve(); } }));
  assert.equal(r.kind, "success");
  assert.deepEqual(slept, [1000]);
});

// D2: nonce DISABLED + post-output idle stall must NOT emit a partial (Spec B suppressed it) -> fatal, no emit.
// FIX D + Q1: nonce disabled, post-output stall -> unified partial terminal (emit partial + loud
// banner + exit 1). NOT a fatal no-emit (superseded), NOT a fresh re-run.
test("nonce disabled + post-output idle stall -> incomplete (partial + banner)", async () => {
  const launch: RunCandidateDeps["launch"] = () =>
    Promise.resolve(outcome({ text: "THINKING", sawAssistantOutput: true }, { idledOut: true }));
  const r = await runCandidate({ ...ctx, nonceEnabled: false }, baseDeps({ launch }));
  assert.equal(r.kind, "incomplete");
  assert.equal(r.kind === "incomplete" && r.text, "THINKING"); // partial emitted
});

// FIX E: a nonce present ONLY in a non-terminal block (empty terminal turn) must NOT read as success.
test("nonce in a non-terminal block (empty terminal turn) -> not success, resumes", async () => {
  const reqs: { prompt: string; continueSession: boolean }[] = [];
  let n = 0;
  const launch: RunCandidateDeps["launch"] = (req) => {
    reqs.push(req);
    const nonce = (/WORK COMPLETE ([0-9a-f]{16})/.exec(req.prompt) ?? [])[1] ?? "";
    n += 1;
    // attempt 1: marker only in `text` (non-terminal), terminalText empty -> np must be false -> resume.
    return Promise.resolve(
      n === 1
        ? outcome({ stopReason: "stop", text: `WORK COMPLETE ${nonce}`, terminalText: "", sawAssistantOutput: true })
        : outcome({ stopReason: "stop", text: `done\nWORK COMPLETE ${nonce}`, terminalText: `done\nWORK COMPLETE ${nonce}`, sawAssistantOutput: true }),
    );
  };
  const r = await runCandidate(ctx, baseDeps({ launch }));
  assert.equal(r.kind, "success");
  assert.equal(reqs.length, 2);            // did not accept the non-terminal marker; resumed
  assert.equal(reqs[1].continueSession, true);
});

// LOW-2/3: pin the throttled label, the MAX_OUTAGE_RETRIES bound, and the idle+overall precedence.
test("throttled probe logs 'rate-limited', down logs 'unreachable'", async () => {
  const warns: string[] = [];
  const throttledThenUp = (() => { let i = 0; return () => Promise.resolve<Reachability>(i++ === 0 ? "throttled" : "up"); })();
  // First launch is incomplete (no nonce) to force the gate; the resume then completes.
  let n = 0;
  const launch: RunCandidateDeps["launch"] = (req) => {
    const nonce = (/WORK COMPLETE ([0-9a-f]{16})/.exec(req.prompt) ?? [])[1] ?? "";
    n += 1;
    return Promise.resolve(n === 1
      ? outcome({ stopReason: "stop", text: "no nonce", terminalText: "no nonce", sawAssistantOutput: true })
      : outcome({ stopReason: "stop", text: `WORK COMPLETE ${nonce}`, terminalText: `WORK COMPLETE ${nonce}`, sawAssistantOutput: true }));
  };
  await runCandidate(ctx, baseDeps({ launch, probe: throttledThenUp, sleep: () => Promise.resolve(), warn: (m) => warns.push(m) }));
  assert.ok(warns.some((w) => w.includes("rate-limited")));
  assert.ok(!warns.some((w) => w.includes("unreachable")));
});

test("a flapping network (down/up forever) terminates at MAX_OUTAGE_RETRIES with transient", async () => {
  // Idle every attempt; probe recovers each time -> retrySameCandidateAfterOutage relaunches without
  // spending resume budget. Bounded by MAX_OUTAGE_RETRIES so it cannot loop forever.
  const probe = (() => { let i = 0; return () => Promise.resolve<Reachability>(i++ % 2 === 0 ? "down" : "up"); })();
  const launch: RunCandidateDeps["launch"] = () => Promise.resolve(outcome({}, { idledOut: true })); // pre-output idle, no session
  const r = await runCandidate(ctx, baseDeps({ launch, probe, sleep: () => Promise.resolve() }));
  assert.equal(r.kind, "transient"); // gave up after MAX_OUTAGE_RETRIES
});

test("ctx.maxOutageRetries override bounds the outage-retry loop itself, not just the backoff ladder", async () => {
  // Unlike "ctx backoff overrides replace the default ladder and cap" (which uses an always-"down"
  // probe, so gate()'s own ladder exhausts first), this drives probe recovery every cycle so
  // retrySameCandidateAfterOutage's own `++outageRetries > maxOutageRetries` check is what
  // terminates the loop. If the override were silently dropped (falling back to the default
  // MAX_OUTAGE_RETRIES = 10), this would run 11 launches instead of 3 and the assertion would fail.
  let launches = 0;
  const launch: RunCandidateDeps["launch"] = () => {
    launches += 1;
    return Promise.resolve(outcome({}, { idledOut: true })); // pre-output idle, no session -> always retries fresh
  };
  const probe = (() => { let i = 0; return () => Promise.resolve<Reachability>(i++ % 2 === 0 ? "down" : "up"); })();
  const r = await runCandidate(
    { ...ctx, maxOutageRetries: 2 },
    baseDeps({ launch, probe, sleep: () => Promise.resolve() }),
  );
  assert.equal(r.kind, "transient");
  assert.equal(launches, 3); // initial launch + 2 retries, then the 3rd recovery exceeds maxOutageRetries=2
});

test("ctx backoff overrides replace the default ladder and cap", async () => {
  const slept: number[] = [];
  const launch: RunCandidateDeps["launch"] = () =>
    Promise.resolve(outcome({ stopReason: "stop", text: "not done", sawAssistantOutput: true }));
  const r = await runCandidate(
    { ...ctx, backoffBaseMs: 10, backoffFactor: 3, backoffCapMs: 90, maxOutageRetries: 1 },
    baseDeps({ launch, probe: () => Promise.resolve("down"), sleep: (ms) => { slept.push(ms); return Promise.resolve(); } }),
  );
  assert.equal(r.kind, "transient");
  assert.deepEqual(slept, [10, 30, 90]); // custom ladder, not the default 1000/2/1024000
});

test("idledOut AND overallTimedOut both set -> idle route (reachability gate) wins (D5)", async () => {
  let probed = false;
  const launch: RunCandidateDeps["launch"] = () =>
    Promise.resolve(outcome({}, { idledOut: true, overallTimedOut: true }));
  const r = await runCandidate(ctx, baseDeps({
    launch,
    probe: () => { probed = true; return Promise.resolve("up"); },
  }));
  assert.equal(probed, true);          // went through the reachability gate (idle route), not classify's transient
  assert.equal(r.kind, "failover");    // pre-output idle + probe up -> ambiguous failover
});
