import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { launchAttempt } from "./launch.ts";

const FAKE = fileURLToPath(new URL("./test-fixtures/fake-pi.mjs", import.meta.url));
chmodSync(FAKE, 0o755);

function base(candidate: string) {
  return { candidate, prompt: "hi", agentDir: "/tmp", piBin: FAKE, startupTimeoutMs: 1000, overallTimeoutMs: 2000 };
}

test("success scenario yields stop reason and reconstructed text", async () => {
  const r = await launchAttempt(base("good-ok"));
  assert.equal(r.outcome.stopReason, "stop");
  assert.equal(r.outcome.text, "RESULT-OK");
  assert.equal(r.startupTimedOut, false);
  assert.equal(r.exitCode, 0);
});

test("model-unavailable scenario surfaces the 400 error string", async () => {
  const r = await launchAttempt(base("bad400"));
  assert.equal(r.outcome.stopReason, "error");
  assert.match(r.outcome.errorMessage ?? "", /^400 Model bad400/);
  assert.equal(r.outcome.sawAssistantOutput, false);
});

test("startup stall trips the startup watchdog", async () => {
  const r = await launchAttempt({ ...base("stall"), startupTimeoutMs: 200, overallTimeoutMs: 5000 });
  assert.equal(r.startupTimedOut, true);
  assert.equal(r.outcome.sawAssistantOutput, false);
});

test("post-startup hang trips the overall watchdog, not the startup one", async () => {
  const r = await launchAttempt({ ...base("hang"), startupTimeoutMs: 1000, overallTimeoutMs: 300 });
  assert.equal(r.startupTimedOut, false);
  assert.equal(r.overallTimedOut, true);
});

test("a SIGTERM-deaf child is reclaimed via SIGKILL escalation instead of hanging", async () => {
  const r = await launchAttempt({ ...base("deaf"), startupTimeoutMs: 1000, overallTimeoutMs: 150, killGraceMs: 50 });
  assert.equal(r.overallTimedOut, true);
  // The promise settled (the test would time out otherwise); the child did not hang us.
  assert.equal(r.outcome.sawAssistantOutput, false);
});

test("spawn failure captures the error in stderr rather than hanging or masking it", async () => {
  const r = await launchAttempt({ ...base("good-ok"), piBin: "/nonexistent/pykrete-pi-xyz" });
  assert.match(r.stderr, /ENOENT|spawn/);
  assert.equal(r.outcome.stopReason, undefined);
  assert.equal(r.exitCode, null);
});

test("pre-output idle: agent_start then hang trips the idle watchdog, sets idledOut", async () => {
  // "hang" emits agent_start then hangs with no output.
  const r = await launchAttempt({ ...base("hang"), startupTimeoutMs: 1000, overallTimeoutMs: 5000, idleTimeoutMs: 200 });
  assert.equal(r.idledOut, true);
  assert.equal(r.outcome.sawAssistantOutput, false);
  assert.equal(r.overallTimedOut, false);
});

test("post-output idle: one line then hang -> idledOut with sawAssistantOutput", async () => {
  const r = await launchAttempt({ ...base("idlepost"), startupTimeoutMs: 1000, overallTimeoutMs: 5000, idleTimeoutMs: 200 });
  assert.equal(r.idledOut, true);
  assert.equal(r.outcome.sawAssistantOutput, true);
});

test("a normal quick run does not trip the idle watchdog", async () => {
  const r = await launchAttempt({ ...base("good-ok"), idleTimeoutMs: 5000 });
  assert.equal(r.idledOut, false);
  assert.equal(r.outcome.stopReason, "stop");
});

test("session flags: --session-dir and --continue appear, --no-session does not", async () => {
  // The "dumpargs" model makes fake-pi echo its argv as the assistant text (added below).
  const r = await launchAttempt({ ...base("dumpargs"), sessionDir: "/tmp/sess-x", continueSession: true });
  assert.match(r.outcome.text, /--session-dir \/tmp\/sess-x/);
  assert.match(r.outcome.text, /--continue/);
  assert.doesNotMatch(r.outcome.text, /--no-session/);
});

test("prompt is delivered to pi on stdin, not argv", async () => {
  const r = await launchAttempt({ ...base("echostdin"), prompt: "HELLO-STDIN" });
  assert.equal(r.outcome.text, "HELLO-STDIN");
});

test("a >128 KiB prompt is delivered whole via stdin (no E2BIG)", async () => {
  const big = "x".repeat(200_000); // over Linux MAX_ARG_STRLEN (131072)
  const r = await launchAttempt({ ...base("echolen"), prompt: big });
  assert.equal(r.outcome.text, `LEN ${big.length}`);
});

test("heartbeat fires periodically with the candidate and a rising clock", async () => {
  const beats: { candidate: string; elapsedMs: number; events: number; idleMs: number }[] = [];
  await launchAttempt({
    ...base("hang"),
    startupTimeoutMs: 1000,
    overallTimeoutMs: 350,
    heartbeatMs: 50,
    heartbeat: (info) => beats.push(info),
  });
  assert.ok(beats.length >= 1, "expected at least one heartbeat");
  assert.equal(beats[0].candidate, "hang");
  assert.ok(beats[beats.length - 1].elapsedMs >= beats[0].elapsedMs);
});
