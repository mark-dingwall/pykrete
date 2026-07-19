// src/pi-events.e2e.test.ts
//
// Real-pi end-to-end guard for the pi 0.80.2 -> 0.80.10 upgrade. GATED: skipped unless
// PYKRETE_NEW_PI_BIN points at the new pi binary. Enable AFTER fast-forwarding pi:
//
//   PYKRETE_NEW_PI_BIN=~/pi/bin/pi \
//   NANOGPT_API_KEY=... \
//   node --experimental-strip-types --test 'src/pi-events.e2e.test.ts'
//
// Optional overrides: PYKRETE_NEW_PI_MODEL (default openai/gpt-5-nano), PYKRETE_NEW_PI_PROVIDER
// (default nanogpt), PYKRETE_E2E_TIMEOUT_MS (default 120000).
//
// It spawns the real new pi exactly as Pykrete does (see src/launch.ts): `-p --mode json --offline
// --provider <p> --model <m>`, prompt delivered on STDIN. It then asserts:
//   (a) a trailing {"type":"agent_settled"} event actually appears in the raw JSONL stream, and
//   (b) feeding the captured stream through createPiEventsAccumulator yields a correct terminal
//       outcome (a clean "stop" latched, assistant output seen, the requested answer in
//       terminalText).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createPiEventsAccumulator } from "./pi-events.ts";
import { createAgentDir, buildModelsJson, buildSettingsJson } from "./agentdir.ts";
import { newPiBin } from "./e2e-gate.ts";

const NEW_PI = newPiBin();
const MODEL = process.env.PYKRETE_NEW_PI_MODEL ?? "openai/gpt-5-nano";
const PROVIDER = process.env.PYKRETE_NEW_PI_PROVIDER ?? "nanogpt";
const TIMEOUT_MS = Number(process.env.PYKRETE_E2E_TIMEOUT_MS ?? "120000");

interface CapturedRun {
  lines: string[];
  exitCode: number | null;
}

function runPi(prompt: string): Promise<CapturedRun> {
  // Mirror src/launch.ts transport: --mode json event stream, prompt on stdin (never argv).
  const args = ["-p", "--mode", "json", "--offline", "--provider", PROVIDER, "--model", MODEL];
  // Supply Pykrete's OWN generated PI_CODING_AGENT_DIR, as launch.ts does. Spawning without it
  // made the test inherit whatever nanogpt provider the operator happens to have configured
  // globally — green on this machine, "Unknown provider" on a clean one, and in neither case a
  // test of the config Pykrete actually ships.
  const agent = createAgentDir(buildModelsJson([MODEL]), buildSettingsJson());
  const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: agent.dir };
  const child = spawn(NEW_PI as string, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  const lines: string[] = [];
  return new Promise<CapturedRun>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`pi did not exit within ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);
    child.stdin.on("error", () => {});
    child.stdin.write(prompt);
    child.stdin.end();
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (l) => lines.push(l));
    child.on("error", (err) => {
      clearTimeout(timer);
      agent.cleanup();
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      agent.cleanup();
      resolve({ lines, exitCode: code });
    });
  });
}

test("real new pi emits a trailing agent_settled and the accumulator still reads the terminal outcome", { skip: !NEW_PI, timeout: TIMEOUT_MS + 5000 }, async () => {
  const { lines } = await runPi("Reply with exactly the single word: PONG");

  // (a) the new lifecycle event actually shows up, verbatim shape {"type":"agent_settled"}.
  const settled = lines
    .map((l) => {
      try {
        return JSON.parse(l) as { type?: unknown };
      } catch {
        return undefined;
      }
    })
    .filter((e): e is { type?: unknown } => !!e && typeof e === "object");
  assert.ok(
    settled.some((e) => e.type === "agent_settled"),
    `expected an agent_settled event in the stream; got types: ${settled.map((e) => e.type).join(",")}`,
  );

  // (b) the captured stream still yields a correct terminal outcome through Pykrete's accumulator.
  const acc = createPiEventsAccumulator();
  for (const l of lines) acc.push(l);
  const r = acc.result();
  // Require a CLEAN stop carrying the answer we asked for. `stopReason !== undefined` accepted
  // stopReason "error" — a run that emitted partial text and then failed would have passed as
  // evidence that the upgraded pi completes successfully. Accept "length" alongside "stop": that
  // is Pykrete's own success contract (classify.ts:43), so demanding only "stop" would false-fail
  // a healthy run whose model chattered up to its output limit.
  assert.ok(
    r.stopReason === "stop" || r.stopReason === "length",
    `expected a clean terminal stop; got ${r.stopReason}, errorMessage: ${r.errorMessage}`,
  );
  assert.equal(r.sawAssistantOutput, true);
  assert.match(r.terminalText, /PONG/, "expected the requested answer in the terminal message text");
});
