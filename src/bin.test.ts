// src/bin.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

const BIN = fileURLToPath(new URL("../bin/pykrete.ts", import.meta.url));
const FAKE = fileURLToPath(new URL("./test-fixtures/fake-pi.mjs", import.meta.url));
chmodSync(FAKE, 0o755);

function writeConfig(glm: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "pykrete-bin-"));
  const path = join(dir, "pykrete.toml");
  writeFileSync(
    path,
    ['default_family = "glm"', "[families]", `glm = [${glm.map((s) => `"${s}"`).join(", ")}]`, "[liveness]", "nonce_enabled = false"].join("\n"),
  );
  return path;
}

// NANOGPT_API_KEY="" forces loadCatalog to skip its fetch (no network in tests);
// fake-pi ignores the key anyway.
function runBin(config: string, prompt: string): SpawnSyncReturns<string> {
  return spawnSync(
    "node",
    ["--experimental-strip-types", BIN, "--config", config, prompt],
    { encoding: "utf-8", env: { ...process.env, PYKRETE_PI_BIN: FAKE, NANOGPT_API_KEY: "" } },
  );
}

function runBinStdin(config: string, input: string): SpawnSyncReturns<string> {
  return spawnSync(
    "node",
    ["--experimental-strip-types", BIN, "--config", config, "-"],
    { input, encoding: "utf-8", maxBuffer: 8 * 1024 * 1024, env: { ...process.env, PYKRETE_PI_BIN: FAKE, NANOGPT_API_KEY: "" } },
  );
}

test("lead succeeds: result on stdout, exit 0", () => {
  const r = runBin(writeConfig(["good-ok", "good-ok-2"]), "do it");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /RESULT-OK/);
});

test("lead unavailable, second succeeds: exit 3", () => {
  const r = runBin(writeConfig(["bad400-lead", "good-ok"]), "do it");
  assert.equal(r.status, 3);
  assert.match(r.stdout, /RESULT-OK/);
});

test("all unavailable: exit 4, nothing on stdout", () => {
  const r = runBin(writeConfig(["bad400-a", "bad400-b"]), "do it");
  assert.equal(r.status, 4);
  assert.equal(r.stdout.trim(), "");
});

test("missing prompt: exit 2", () => {
  const r = spawnSync(
    "node",
    ["--experimental-strip-types", BIN, "--config", writeConfig(["good-ok"])],
    { input: "", encoding: "utf-8", env: { ...process.env, PYKRETE_PI_BIN: FAKE, NANOGPT_API_KEY: "" } },
  );
  assert.equal(r.status, 2);
});

test("large prompt via stdin '-' reaches pi intact (no E2BIG), exit 0", () => {
  const big = "x".repeat(1_200_000); // > 1 MiB, far past MAX_ARG_STRLEN
  const r = runBinStdin(writeConfig(["echolen"]), big);
  assert.equal(r.status, 0);
  assert.match(r.stdout, new RegExp(`LEN ${big.length}\\b`));
});

test("prompt omitted while stdin is piped (non-TTY) is read from stdin", () => {
  const r = spawnSync(
    "node",
    ["--experimental-strip-types", BIN, "--config", writeConfig(["echolen"])],
    { input: "z".repeat(50_000), encoding: "utf-8", maxBuffer: 8 * 1024 * 1024, env: { ...process.env, PYKRETE_PI_BIN: FAKE, NANOGPT_API_KEY: "" } },
  );
  assert.equal(r.status, 0);
  assert.match(r.stdout, /LEN 50000\b/);
});

test("stdin prompt survives failover to a second candidate (exit 3)", () => {
  const prompt = "s".repeat(200_000); // > MAX_ARG_STRLEN: also proves no E2BIG on the failover route
  const r = runBinStdin(writeConfig(["bad400-lead", "echolen"]), prompt);
  assert.equal(r.status, 3); // lead model-unavailable -> downgrade success
  assert.match(r.stdout, /LEN 200000\b/); // the piped prompt reached the 2nd candidate intact
});

test("liveness happy path: a nonce-emitting model exits 0 and strips the marker from stdout", () => {
  // fake-pi 'nonceok' echoes the prompt's nonce in its final block only when NOT resuming.
  // Use a config WITHOUT nonce_enabled=false so the default (nonce on) applies.
  const dir = mkdtempSync(join(tmpdir(), "pykrete-bin-"));
  const path = join(dir, "pykrete.toml");
  writeFileSync(
    path,
    ['default_family = "glm"', "[families]", 'glm = ["nonceok"]'].join("\n"),
  );
  const r = runBin(path, "do it");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /RESULT-OK/);
  assert.doesNotMatch(r.stdout, /WORK COMPLETE/); // sentinel stripped
});

test("nonce disabled via config: clean stop is success (Spec B parity), exit 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "pykrete-bin-"));
  const path = join(dir, "pykrete.toml");
  writeFileSync(
    path,
    ['default_family = "glm"', "[families]", 'glm = ["good-ok"]', "[liveness]", "nonce_enabled = false"].join("\n"),
  );
  const r = runBin(path, "do it");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /RESULT-OK/);
});

test("end-to-end resume: attempt 1 writes a .jsonl and stops without the nonce; --continue completes -> exit 0", async () => {
  // Local stub so the resume's reachability probe reports `up` without touching the real network.
  // NOTE: spawnSync blocks the event loop, so the HTTP server could not accept connections while
  // the child runs. We use async spawn (wrapped in a Promise) to keep the parent event loop alive.
  const server = createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const dir = mkdtempSync(join(tmpdir(), "pykrete-bin-"));
    const path = join(dir, "pykrete.toml");
    // nonce ON (default), resume budget 1.
    writeFileSync(path, ['default_family = "glm"', "[families]", 'glm = ["resume2step"]', "[liveness]", "resume_attempts = 1"].join("\n"));
    const { status, stdout } = await new Promise<{ status: number | null; stdout: string }>((resolve) => {
      const child = spawn(
        "node",
        ["--experimental-strip-types", BIN, "--config", path, "do it"],
        { env: { ...process.env, PYKRETE_PI_BIN: FAKE, NANOGPT_API_KEY: "", PYKRETE_MODELS_URL: `http://127.0.0.1:${port}/models` } },
      );
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf-8"); });
      child.on("close", (code: number | null) => resolve({ status: code, stdout: out }));
    });
    assert.equal(status, 0);              // resumed and completed
    assert.match(stdout, /RESULT-OK/);    // the resume's answer reached stdout
    assert.doesNotMatch(stdout, /WORK COMPLETE/); // sentinel stripped
    assert.doesNotMatch(stdout, /PARTIAL-WORK/);  // attempt-1 partial NOT emitted (success supersedes it)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
