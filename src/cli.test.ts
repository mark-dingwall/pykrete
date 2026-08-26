import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgv, run, wantsHelp, HELP } from "./cli.ts";

function writeConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), "pykrete-cli-"));
  const path = join(dir, "pykrete.toml");
  writeFileSync(
    path,
    [
      'default_family = "glm"',
      "[families]",
      'glm = ["zai-org/glm-5.2:thinking", "zai-org/glm-5.2", "zai-org/glm-5.1:thinking"]',
      "[defaults.code]",
      'glm = "zai-org/glm-5.2:thinking"',
    ].join("\n"),
  );
  return path;
}

function models(ids: string[]): typeof fetch {
  return (async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 })) as typeof fetch;
}

test("parseArgv extracts flags and the positional prompt", () => {
  const p = parseArgv(["--task", "code", "--family", "glm", "write", "a", "test"]);
  assert.equal(p.task, "code");
  assert.equal(p.family, "glm");
  assert.equal(p.prompt, "write a test");
  assert.equal(p.configPath, "pykrete.toml");
});

test("wantsHelp is true for --help or -h", () => {
  assert.equal(wantsHelp(["--help"]), true);
  assert.equal(wantsHelp(["-h"]), true);
  assert.equal(wantsHelp(["--task", "code", "do it"]), false);
  assert.equal(wantsHelp([]), false);
});

test("HELP mentions every flag and the exit-code contract", () => {
  for (const needle of ["--task", "--family", "--config", "--help", "NANOGPT_API_KEY", "exit", "prompt"]) {
    assert.ok(HELP.includes(needle), `HELP missing ${needle}`);
  }
});

test("run resolves candidates with no catalog (no api key)", async () => {
  const config = writeConfig();
  const warnings: string[] = [];
  const r = await run(["--task", "code", "--family", "glm", "--config", config], {
    apiKey: undefined,
    cacheDir: mkdtempSync(join(tmpdir(), "pykrete-cache-")),
    warn: (m) => warnings.push(m),
  });
  assert.deepEqual(r.candidates, [
    "zai-org/glm-5.2:thinking",
    "zai-org/glm-5.2",
    "zai-org/glm-5.1:thinking",
  ]);
  assert.equal(r.intendedLead, "zai-org/glm-5.2:thinking");
  assert.ok(warnings.some((w) => /NANOGPT_API_KEY/.test(w)));
});

test("run applies catalog reorder when a catalog is available", async () => {
  const config = writeConfig();
  const r = await run(["--task", "code", "--family", "glm", "--config", config], {
    apiKey: "k",
    cacheDir: mkdtempSync(join(tmpdir(), "pykrete-cache-")),
    // Only the second-ranked id is "live" -> it moves to the front.
    fetchImpl: models(["zai-org/glm-5.2"]),
  });
  assert.equal(r.candidates[0], "zai-org/glm-5.2");
  // intendedLead is the PRE-reorder head, unchanged by catalog.
  assert.equal(r.intendedLead, "zai-org/glm-5.2:thinking");
});

test("run warns on zero catalog intersection but keeps the list intact", async () => {
  const config = writeConfig();
  const warnings: string[] = [];
  const r = await run(["--family", "glm", "--config", config], {
    apiKey: "k",
    cacheDir: mkdtempSync(join(tmpdir(), "pykrete-cache-")),
    fetchImpl: models(["something/unrelated"]),
    warn: (m) => warnings.push(m),
  });
  assert.equal(r.candidates.length, 3);
  assert.ok(warnings.some((w) => /matched none/.test(w)));
});
