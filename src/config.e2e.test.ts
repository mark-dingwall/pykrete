import { test } from "node:test";
import assert from "node:assert/strict";
import { buildModelsJson, buildSettingsJson, createAgentDir } from "./agentdir.ts";
import { launchAttempt } from "./launch.ts";
import { newPiBin } from "./e2e-gate.ts";

// Real-pi ground-truth check for the models.json + settings.json config contract.
//
// The unit tests in agentdir.test.ts are structural guards transcribed from pi
// source (Pykrete can't import pi's TypeBox schema — no dependency). THIS test is
// the authoritative check: it writes Pykrete's real config into a temp
// PI_CODING_AGENT_DIR and spawns the *new* pi binary, proving the config is not
// rejected and the custom nanogpt provider is not shadowed by pi.dev/R2 catalogs.
//
// GATED: skipped unless PYKRETE_NEW_PI_BIN points at the upgraded pi (~0.80.10).
// Enable after the pi fast-forward:
//   PYKRETE_NEW_PI_BIN=/path/to/new/pi \
//   PYKRETE_E2E_CANDIDATE="<valid nanogpt model id>" \
//   PYKRETE_NANOGPT_API_KEY="<real key>" \   # optional; enables the positive path
//   node --experimental-strip-types --test 'src/config.e2e.test.ts'
const NEW_PI = newPiBin();
// A model id that must exist in the NanoGPT catalog. Override per environment.
const CANDIDATE = process.env.PYKRETE_E2E_CANDIDATE ?? "moonshotai/kimi-k2-instruct";
const API_KEY = process.env.PYKRETE_NANOGPT_API_KEY;

// Substrings that would appear only if new-pi REJECTED our config files. A valid
// config never mentions models.json/settings.json at all. Anchored to the error
// strings in pi model-config.ts (ModelConfig.load) and settings-manager.ts.
const CONFIG_REJECTION_MARKERS = [
  /invalid models\.json schema/i,
  /failed to parse models\.json/i,
  /failed to load models\.json/i,
  /models\.json error/i,
  /models\.json/i,
  /settings\.json/i,
];

// Substrings that would appear only if the custom `nanogpt` provider/model was
// unknown to pi (i.e. shadowed / not registered from our models.json).
const SHADOW_MARKERS = [
  /unknown model/i,
  // pi's ACTUAL diagnostic for an unregistered provider, verbatim from
  // model-resolver.ts:398 — `Unknown provider "nanogpt". Use --list-models ...`.
  // None of the looser patterns below match it, so without this line the shadow
  // test passed against the exact upstream error it exists to catch.
  /unknown provider/i,
  /provider .*not found/i,
  /no provider/i,
  /provider .*nanogpt.* not/i,
  /model .*not (found|configured|available in)/i,
];

async function run(agentDir: string): Promise<{ haystack: string; outcome: Awaited<ReturnType<typeof launchAttempt>> }> {
  const outcome = await launchAttempt({
    candidate: CANDIDATE,
    prompt: "Reply with the single word: ok",
    agentDir,
    apiKey: API_KEY,
    piBin: NEW_PI,
    startupTimeoutMs: 60_000,
    overallTimeoutMs: 120_000,
  });
  const haystack = `${outcome.stderr}\n${outcome.outcome.errorMessage ?? ""}`;
  // Both tests below are negative (assert an error string is ABSENT), which a run that never
  // produced any output satisfies trivially. Require positive evidence that pi actually started
  // and got as far as OUR provider before the assertions are allowed to mean anything.
  //
  // Two shapes count. With a key, pi reaches inference and emits a terminal event. WITHOUT one
  // (the documented optional-key invocation) pi never gets there: it fails the auth preflight in
  // agent-session.ts before _runAgentPrompt, and print-mode.ts:149 catches it, writes the message
  // to stderr and exits with no terminal JSON at all. That diagnostic still names `nanogpt` — a
  // provider that exists only in the models.json under test — so it is itself proof pi loaded our
  // config and resolved the custom provider.
  // The provider name is load-bearing, so match it: an unanchored /no api key found for/ would
  // also accept `No API key found for openai.` from a wrapper or mispointed binary that exited
  // before ever reading our agent dir, re-opening the fail-open path. pi emits the name unquoted
  // from auth-guidance.ts:24 and quoted from model-registry.ts:58; accept either.
  const ranFarEnough =
    outcome.outcome.stopReason !== undefined || /no api key found for "?nanogpt"?/i.test(outcome.stderr);
  assert.ok(
    ranFarEnough,
    `pi produced neither a terminal event nor the nanogpt auth preflight — it likely never ran, so the assertions below prove nothing. stderr: ${outcome.stderr}`,
  );
  return { haystack, outcome };
}

test(
  "new-pi accepts Pykrete's models.json + settings.json (no schema/config rejection)",
  { skip: NEW_PI ? false : "set PYKRETE_NEW_PI_BIN to the upgraded pi to run" },
  async () => {
    const agent = createAgentDir(buildModelsJson([CANDIDATE]), buildSettingsJson());
    try {
      const { haystack } = await run(agent.dir);
      for (const marker of CONFIG_REJECTION_MARKERS) {
        assert.ok(!marker.test(haystack), `new-pi rejected the config (matched ${marker}):\n${haystack}`);
      }
    } finally {
      agent.cleanup();
    }
  },
);

test(
  "new-pi does not shadow the custom nanogpt provider's model",
  { skip: NEW_PI ? false : "set PYKRETE_NEW_PI_BIN to the upgraded pi to run" },
  async () => {
    const agent = createAgentDir(buildModelsJson([CANDIDATE]), buildSettingsJson());
    try {
      const { haystack, outcome } = await run(agent.dir);
      // Negative: pi must not report our provider/model as unknown. Holds even
      // without an API key (an auth failure is not a shadow/unknown-model error).
      for (const marker of SHADOW_MARKERS) {
        assert.ok(!marker.test(haystack), `nanogpt provider appears shadowed (matched ${marker}):\n${haystack}`);
      }
      // Positive (only with a real key): the custom provider's model actually ran.
      if (API_KEY) {
        assert.ok(
          outcome.outcome.sawAssistantOutput,
          `expected assistant output from the custom nanogpt provider; got: ${JSON.stringify(outcome.outcome)}`,
        );
      }
    } finally {
      agent.cleanup();
    }
  },
);
