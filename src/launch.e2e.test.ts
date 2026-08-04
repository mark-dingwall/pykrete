import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchAttempt } from "./launch.ts";
import { createAgentDir, buildModelsJson, buildSettingsJson } from "./agentdir.ts";
import { newPiBin } from "./e2e-gate.ts";

// Real-pi, real-NanoGPT reproduction of the 2026-07-21 flat-edit bug (docs/BACKLOG.md,
// "Correctness"): DeepSeek-via-NanoGPT got pi's built-in nested edits[] schema and deterministically
// failed to edit an existing file. Gated exactly like classify.e2e.test.ts's DS4 case.
const NEW_PI = newPiBin();
const DS4_MODEL = process.env.PYKRETE_DS4_MODEL;

const cleanups: Array<() => void> = [];
after(() => {
  for (const c of cleanups) c();
});

test(
  "new pi: deepseek candidate can edit an existing file via the flat-edit extension",
  { skip: !NEW_PI || !DS4_MODEL },
  async () => {
    const scratchDir = mkdtempSync(join(tmpdir(), "pykrete-flatedit-e2e-"));
    cleanups.push(() => rmSync(scratchDir, { recursive: true, force: true }));
    const targetFile = join(scratchDir, "target.txt");
    writeFileSync(targetFile, "before");

    const agent = createAgentDir(buildModelsJson([DS4_MODEL!]), buildSettingsJson());
    cleanups.push(agent.cleanup);

    const r = await launchAttempt({
      candidate: DS4_MODEL!,
      family: "deepseek",
      prompt: `Edit the file at ${targetFile} by replacing its exact contents "before" with "after". Use the edit tool.`,
      agentDir: agent.dir,
      apiKey: process.env.NANOGPT_API_KEY,
      piBin: NEW_PI,
      startupTimeoutMs: 60_000,
      overallTimeoutMs: 120_000,
    });

    assert.equal(r.outcome.stopReason, "stop", `stderr: ${r.stderr}, text: ${r.outcome.text}`);
    assert.equal(readFileSync(targetFile, "utf8"), "after");
  },
);
