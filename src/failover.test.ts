import { test } from "node:test";
import assert from "node:assert/strict";
import { runFailover, type FailoverDeps } from "./failover.ts";
import type { CandidateResult } from "./runCandidate.ts";

function deps(scripted: Record<string, CandidateResult>, sink: { out: string[]; warn: string[] }): FailoverDeps {
  return {
    runCandidate: (candidate) => Promise.resolve(scripted[candidate]),
    now: () => 0,
    warn: (m) => sink.warn.push(m),
    emit: (t) => sink.out.push(t),
  };
}

test("lead success -> exit 0, result emitted", async () => {
  const sink = { out: [] as string[], warn: [] as string[] };
  const r = await runFailover(
    { candidates: ["lead", "b"], intendedLead: "lead", prompt: "p" },
    deps({ lead: { kind: "success", text: "ANS", pausedMs: 0 } }, sink),
  );
  assert.equal(r.exitCode, 0);
  assert.deepEqual(sink.out, ["ANS"]);
});

test("resumed success on a substituted candidate is transparent -> exit 3", async () => {
  const sink = { out: [] as string[], warn: [] as string[] };
  const r = await runFailover(
    { candidates: ["lead", "b"], intendedLead: "lead", prompt: "p" },
    deps(
      {
        lead: { kind: "failover", verdict: { kind: "model-unavailable" }, pausedMs: 0 },
        b: { kind: "success", text: "ANS", pausedMs: 0 },
      },
      sink,
    ),
  );
  assert.equal(r.exitCode, 3);
  assert.equal(r.launchedId, "b");
});

test("incomplete -> exit 1, partial emitted, no next candidate tried", async () => {
  const sink = { out: [] as string[], warn: [] as string[] };
  let bTried = false;
  const d: FailoverDeps = {
    runCandidate: (c) => {
      if (c === "b") bTried = true;
      return Promise.resolve<CandidateResult>(
        c === "a" ? { kind: "incomplete", text: "PARTIAL", message: "resume budget exhausted", pausedMs: 0 } : { kind: "success", text: "X", pausedMs: 0 },
      );
    },
    now: () => 0, warn: (m) => sink.warn.push(m), emit: (t) => sink.out.push(t),
  };
  const r = await runFailover({ candidates: ["a", "b"], intendedLead: "a", prompt: "p" }, d);
  assert.equal(r.exitCode, 1);
  assert.deepEqual(sink.out, ["PARTIAL"]);           // partial on STDOUT
  assert.ok(sink.warn.some((w) => /WARNING: PARTIAL OUTPUT/.test(w))); // loud banner on STDERR
  assert.ok(sink.warn.some((w) => w.includes("resume budget exhausted"))); // with the reason
  assert.equal(bTried, false);
});

test("all model-unavailable -> exit 4", async () => {
  const sink = { out: [] as string[], warn: [] as string[] };
  const r = await runFailover(
    { candidates: ["a", "b"], intendedLead: "a", prompt: "p" },
    deps(
      {
        a: { kind: "failover", verdict: { kind: "model-unavailable" }, pausedMs: 0 },
        b: { kind: "failover", verdict: { kind: "model-unavailable" }, pausedMs: 0 },
      },
      sink,
    ),
  );
  assert.equal(r.exitCode, 4);
});

test("an ambiguous stall in the mix -> exit 1, never 4", async () => {
  const sink = { out: [] as string[], warn: [] as string[] };
  const r = await runFailover(
    { candidates: ["a", "b"], intendedLead: "a", prompt: "p" },
    deps(
      {
        a: { kind: "failover", verdict: { kind: "ambiguous", message: "stall" }, pausedMs: 0 },
        b: { kind: "failover", verdict: { kind: "model-unavailable" }, pausedMs: 0 },
      },
      sink,
    ),
  );
  assert.equal(r.exitCode, 1);
});

test("fatal -> exit 1, no further attempts, nothing emitted", async () => {
  const sink = { out: [] as string[], warn: [] as string[] };
  let bTried = false;
  const d: FailoverDeps = {
    runCandidate: (c) => {
      if (c === "b") bTried = true;
      return Promise.resolve<CandidateResult>(
        c === "a" ? { kind: "fatal", message: "bad API key", pausedMs: 0 } : { kind: "success", text: "X", pausedMs: 0 },
      );
    },
    now: () => 0, warn: (m) => sink.warn.push(m), emit: (t) => sink.out.push(t),
  };
  const r = await runFailover({ candidates: ["a", "b"], intendedLead: "a", prompt: "p" }, d);
  assert.equal(r.exitCode, 1);
  assert.equal(bTried, false);
  assert.deepEqual(sink.out, []);
});

test("transient -> exit 1, stops", async () => {
  const sink = { out: [] as string[], warn: [] as string[] };
  const r = await runFailover(
    { candidates: ["a", "b"], intendedLead: "a", prompt: "p" },
    deps({ a: { kind: "transient", message: "gave up after backoff", pausedMs: 0 } }, sink),
  );
  assert.equal(r.exitCode, 1);
});

test("pausedMs is excluded from the deadline: an outage-waiting candidate still gets its budget", async () => {
  const sink = { out: [] as string[], warn: [] as string[] };
  let clock = 0;
  const d: FailoverDeps = {
    // Candidate "a" waited out a 10_000ms outage (pausedMs) and failed over; without the pause
    // exclusion the deadline (deadlineMs 5_000) would trip before "lead" is tried.
    runCandidate: (c) => {
      clock += 10_000;
      return Promise.resolve<CandidateResult>(
        c === "a"
          ? { kind: "failover", verdict: { kind: "model-unavailable" }, pausedMs: 10_000 }
          : { kind: "success", text: "ANS", pausedMs: 0 },
      );
    },
    now: () => clock,
    warn: (m) => sink.warn.push(m),
    emit: (t) => sink.out.push(t),
    deadlineMs: 5_000,
  };
  const r = await runFailover({ candidates: ["a", "lead"], intendedLead: "lead", prompt: "p" }, d);
  assert.equal(r.exitCode, 0);
  assert.equal(r.launchedId, "lead");
});

test("deadline exceeded before an attempt (no pause) -> exit 1", async () => {
  const sink = { out: [] as string[], warn: [] as string[] };
  let clock = 0;
  const d: FailoverDeps = {
    runCandidate: () => {
      clock += 1000;
      return Promise.resolve<CandidateResult>({ kind: "failover", verdict: { kind: "model-unavailable" }, pausedMs: 0 });
    },
    now: () => clock, warn: (m) => sink.warn.push(m), emit: (t) => sink.out.push(t), deadlineMs: 500,
  };
  const r = await runFailover({ candidates: ["a", "b"], intendedLead: "a", prompt: "p" }, d);
  assert.equal(r.exitCode, 1);
});
