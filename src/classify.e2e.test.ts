import { test, after } from "node:test";
import assert from "node:assert/strict";
import { launchAttempt } from "./launch.ts";
import { classify, parseStatus } from "./classify.ts";
import { createAgentDir, buildModelsJson, buildSettingsJson } from "./agentdir.ts";
import { newPiBin } from "./e2e-gate.ts";

// Real-pi e2e, GATED behind PYKRETE_NEW_PI_BIN (path to the supported 0.84.3 `pi` binary).
// Skipped when the env var is unset (i.e. now); run after fast-forward to confirm the colon-form
// fixtures in classify.test.ts match what the real new pi actually emits.
//
//   PYKRETE_NEW_PI_BIN=/path/to/pi NANOGPT_API_KEY=... \
//     node --experimental-strip-types --test 'src/classify.e2e.test.ts'
//
// The DS4 overflow case additionally needs PYKRETE_DS4_MODEL (a real DeepSeek-V4 model id) and is
// skipped unless both it and PYKRETE_NEW_PI_BIN are set.
const NEW_PI = newPiBin();
const DS4_MODEL = process.env.PYKRETE_DS4_MODEL;

// error-body.ts colon-form: `"<status>: <body>"`, status is 3 digits, separator is ": ", body is
// the JSON-stringified provider error body (starts with "{").
const COLON_FORM = /^\d{3}: \{/;

// Provision an agent dir with Pykrete's real models.json (defining the nanogpt provider + the
// candidate model) and settings.json, exactly as bin does — else pi errors "Unknown provider".
// Cleanup is deferred to an `after` hook so it runs even when an assertion throws; dropping the
// handle leaked a pykrete-agent-* dir in /tmp per enabled run.
const cleanups: Array<() => void> = [];
after(() => {
  for (const c of cleanups) c();
});
function agentDirFor(candidate: string): string {
  const agent = createAgentDir(buildModelsJson([candidate]), buildSettingsJson());
  cleanups.push(agent.cleanup);
  return agent.dir;
}

test(
  "new pi: bogus model id surfaces colon-form errorMessage -> model-unavailable",
  { skip: !NEW_PI },
  async () => {
    const r = await launchAttempt({
      candidate: "definitely-not-a-real-model/xyz",
      prompt: "hello",
      agentDir: agentDirFor("definitely-not-a-real-model/xyz"),
      apiKey: process.env.NANOGPT_API_KEY,
      piBin: NEW_PI,
      startupTimeoutMs: 60_000,
      overallTimeoutMs: 60_000,
    });
    assert.equal(r.outcome.stopReason, "error", `stderr: ${r.stderr}`);
    assert.ok(
      COLON_FORM.test(r.outcome.errorMessage ?? ""),
      `expected colon-form errorMessage, got: ${JSON.stringify(r.outcome.errorMessage)}`,
    );
    // The launched id echoes into the body -> modelReferenced -> failover, not fatal.
    assert.equal(classify(r.outcome, { startupTimedOut: false, overallTimedOut: false }, false).kind, "model-unavailable");
  },
);

test(
  "new pi: oversized prompt on real DS4 surfaces colon-form 413 -> fatal",
  { skip: !NEW_PI || !DS4_MODEL },
  async () => {
    // Real DS4 models expose a 1,048,576-token context (per NanoGPT catalog), so overflow needs
    // >1M tokens. 45 chars/repeat * 120_000 ≈ 5.4M chars ≈ ~1.3M tokens, comfortably past 1M.
    // What actually comes back is 413 "Request Entity Too Large", NOT 400 context_length_exceeded:
    // a prompt that large trips NanoGPT's request-body limit before any context check, so the 400
    // overflow path is unreachable on 1M-token models. Cheap to run — 413 is rejected at the edge,
    // so no tokens are billed.
    const huge = "The quick brown fox jumps over the lazy dog. ".repeat(120_000);
    const r = await launchAttempt({
      candidate: DS4_MODEL!,
      prompt: huge,
      agentDir: agentDirFor(DS4_MODEL!),
      apiKey: process.env.NANOGPT_API_KEY,
      piBin: NEW_PI,
      startupTimeoutMs: 120_000,
      overallTimeoutMs: 120_000,
    });
    assert.equal(r.outcome.stopReason, "error", `stderr: ${r.stderr}`);
    assert.ok(
      COLON_FORM.test(r.outcome.errorMessage ?? ""),
      `expected colon-form errorMessage, got: ${JSON.stringify(r.outcome.errorMessage)}`,
    );
    // Pin the STATUS, not just "some colon-form error". Without this the test passes on any fatal
    // status — an expired key's 401 satisfies the colon-form regex and also classifies fatal, so
    // the test would report green while never exercising the request-body limit it is named for.
    assert.equal(
      parseStatus(r.outcome.errorMessage ?? ""),
      413,
      `expected a 413 from NanoGPT's request-body limit, got: ${JSON.stringify(r.outcome.errorMessage)}`,
    );
    assert.match(r.outcome.errorMessage ?? "", /request entity too large/i);
    // 413 carries no model reference -> the oversized prompt recurs on every candidate -> fatal.
    assert.equal(classify(r.outcome, { startupTimedOut: false, overallTimedOut: false }, false).kind, "fatal");
  },
);
