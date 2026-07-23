// src/bin.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

// A fresh, TTL-valid catalog cache keyed to `apiKey` so loadCatalog's real network fetch
// (hardcoded to nano-gpt.com, no test seam) is never reached from these .env tests.
function seedCatalogCache(apiKey: string): string {
  const cacheRoot = mkdtempSync(join(tmpdir(), "pykrete-cache-"));
  const cacheDir = join(cacheRoot, "pykrete");
  mkdirSync(cacheDir, { recursive: true });
  const hash = createHash("sha256").update(apiKey).digest("hex");
  writeFileSync(join(cacheDir, `catalog-${hash}.json`), JSON.stringify(["dumpenv"]));
  return cacheRoot;
}

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

// NANOGPT_API_KEY="" forces loadCatalog to skip its fetch (no network in tests); fake-pi ignores
// the key anyway. This only holds if cwd has no .env: bin/pykrete.ts treats an empty shell key as
// absent and lets .env fill it in, so cwd must be an isolated tmpdir (never the repo root, which
// may have a real .env for manual testing) or a real key would leak in and get a real network hit.
function runBin(config: string, prompt: string): SpawnSyncReturns<string> {
  return spawnSync(
    "node",
    ["--experimental-strip-types", BIN, "--config", config, prompt],
    { encoding: "utf-8", cwd: dirname(config), env: { ...process.env, PYKRETE_PI_BIN: FAKE, NANOGPT_API_KEY: "", PYKRETE_SKIP_KEY_PREFLIGHT: "1" } },
  );
}

function runBinStdin(config: string, input: string): SpawnSyncReturns<string> {
  return spawnSync(
    "node",
    ["--experimental-strip-types", BIN, "--config", config, "-"],
    { input, encoding: "utf-8", maxBuffer: 8 * 1024 * 1024, cwd: dirname(config), env: { ...process.env, PYKRETE_PI_BIN: FAKE, NANOGPT_API_KEY: "", PYKRETE_SKIP_KEY_PREFLIGHT: "1" } },
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
  const configPath = writeConfig(["good-ok"]);
  const r = spawnSync(
    "node",
    ["--experimental-strip-types", BIN, "--config", configPath],
    { input: "", encoding: "utf-8", cwd: dirname(configPath), env: { ...process.env, PYKRETE_PI_BIN: FAKE, NANOGPT_API_KEY: "", PYKRETE_SKIP_KEY_PREFLIGHT: "1" } },
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
  const configPath = writeConfig(["echolen"]);
  const r = spawnSync(
    "node",
    ["--experimental-strip-types", BIN, "--config", configPath],
    { input: "z".repeat(50_000), encoding: "utf-8", maxBuffer: 8 * 1024 * 1024, cwd: dirname(configPath), env: { ...process.env, PYKRETE_PI_BIN: FAKE, NANOGPT_API_KEY: "", PYKRETE_SKIP_KEY_PREFLIGHT: "1" } },
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
        { cwd: dirname(path), env: { ...process.env, PYKRETE_PI_BIN: FAKE, NANOGPT_API_KEY: "", PYKRETE_SKIP_KEY_PREFLIGHT: "1", PYKRETE_MODELS_URL: `http://127.0.0.1:${port}/models` } },
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

test("no NANOGPT_API_KEY, no .env in cwd: exit 2", () => {
  const { NANOGPT_API_KEY, PYKRETE_SKIP_KEY_PREFLIGHT, ...rest } = process.env;
  const configPath = writeConfig(["good-ok"]); // absolute path, in a fresh empty tmpdir
  const r = spawnSync(
    "node",
    ["--experimental-strip-types", BIN, "--config", configPath, "do it"],
    { encoding: "utf-8", env: rest, cwd: dirname(configPath) },
  );
  assert.equal(r.status, 2);
  assert.match(r.stderr, /NANOGPT_API_KEY/);
});

test(".env in cwd supplies NANOGPT_API_KEY and it reaches the launched pi", () => {
  const { NANOGPT_API_KEY, PYKRETE_SKIP_KEY_PREFLIGHT, ...rest } = process.env;
  const key = "envkey-abc123";
  const envDir = mkdtempSync(join(tmpdir(), "pykrete-envcwd-"));
  writeFileSync(join(envDir, ".env"), `NANOGPT_API_KEY=${key}\n`);
  const cacheRoot = seedCatalogCache(key);
  const configPath = writeConfig(["dumpenv"]);
  const r = spawnSync(
    "node",
    ["--experimental-strip-types", BIN, "--config", configPath, "do it"],
    { encoding: "utf-8", cwd: envDir, env: { ...rest, PYKRETE_PI_BIN: FAKE, XDG_CACHE_HOME: cacheRoot } },
  );
  assert.equal(r.status, 0);
  assert.match(r.stdout, new RegExp(`ENVKEY=${key}\\b`));
});

test("shell env NANOGPT_API_KEY wins over a .env value in cwd", () => {
  const { NANOGPT_API_KEY, PYKRETE_SKIP_KEY_PREFLIGHT, ...rest } = process.env;
  const shellKey = "envkey-fromshell";
  const envDir = mkdtempSync(join(tmpdir(), "pykrete-envcwd-"));
  writeFileSync(join(envDir, ".env"), "NANOGPT_API_KEY=envkey-fromdotenv\n");
  const cacheRoot = seedCatalogCache(shellKey);
  const configPath = writeConfig(["dumpenv"]);
  const r = spawnSync(
    "node",
    ["--experimental-strip-types", BIN, "--config", configPath, "do it"],
    {
      encoding: "utf-8",
      cwd: envDir,
      env: { ...rest, NANOGPT_API_KEY: shellKey, PYKRETE_PI_BIN: FAKE, XDG_CACHE_HOME: cacheRoot },
    },
  );
  assert.equal(r.status, 0);
  assert.match(r.stdout, new RegExp(`ENVKEY=${shellKey}\\b`));
});

test(".env cannot set PYKRETE_SKIP_KEY_PREFLIGHT", () => {
  const { NANOGPT_API_KEY, PYKRETE_SKIP_KEY_PREFLIGHT, PYKRETE_PI_BIN, ...rest } = process.env;
  const envDir = mkdtempSync(join(tmpdir(), "pykrete-envcwd-"));
  writeFileSync(
    join(envDir, ".env"),
    `PYKRETE_SKIP_KEY_PREFLIGHT=1\nPYKRETE_PI_BIN=${FAKE}\n`,
  );
  const configPath = writeConfig(["good-ok"]);
  const r = spawnSync(
    "node",
    ["--experimental-strip-types", BIN, "--config", configPath, "do it"],
    { encoding: "utf-8", cwd: envDir, env: rest },
  );
  // Preflight must still fire: the .env's skip flag must not apply. This does NOT prove
  // PYKRETE_PI_BIN was stripped too -- preflight exits before any pi resolution -- see the
  // dedicated PYKRETE_PI_BIN test below for that.
  assert.equal(r.status, 2);
  assert.match(r.stderr, /NANOGPT_API_KEY/);
});

test(".env cannot set PYKRETE_PI_BIN: a .env-selected binary is never spawned", async () => {
  // Async spawn + a local reachability stub, mirroring the resume test above: the spawned pi's
  // ENOENT is classified as unclassified/ambiguous, which drives a reachability probe before
  // exhausting -- without a stub that probe would hit the real nano-gpt.com and, on an offline
  // host, run the full outage backoff (many minutes) before giving up.
  const server = createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const { NANOGPT_API_KEY, PYKRETE_SKIP_KEY_PREFLIGHT, PYKRETE_PI_BIN, ...rest } = process.env;
    const key = "envkey-pibin-guard";
    const envDir = mkdtempSync(join(tmpdir(), "pykrete-envcwd-"));
    writeFileSync(join(envDir, ".env"), `NANOGPT_API_KEY=${key}\nPYKRETE_PI_BIN=${FAKE}\n`);
    const cacheRoot = seedCatalogCache(key);
    const configPath = writeConfig(["good-ok"]);
    // A PATH containing only a `node` symlink: FAKE's `#!/usr/bin/env node` shebang needs `node` on
    // PATH to run at all, so PATH: "" would make FAKE itself unrunnable -- both a leaked-through
    // PYKRETE_PI_BIN and a correctly-stripped one would then fail via "env: 'node': No such file",
    // and the test couldn't tell the two cases apart. This keeps `node` resolvable while the bare
    // "pi" launch.ts falls back to on a correct strip still has nothing to resolve against.
    const nodeOnlyPath = mkdtempSync(join(tmpdir(), "pykrete-nodepath-"));
    symlinkSync(process.execPath, join(nodeOnlyPath, "node"));
    const { status, stdout } = await new Promise<{ status: number | null; stdout: string }>((resolve) => {
      const child = spawn(
        process.execPath,
        ["--experimental-strip-types", BIN, "--config", configPath, "do it"],
        {
          cwd: envDir,
          env: { ...rest, XDG_CACHE_HOME: cacheRoot, PATH: nodeOnlyPath, PYKRETE_MODELS_URL: `http://127.0.0.1:${port}/models` },
        },
      );
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf-8"); });
      child.on("close", (code: number | null) => resolve({ status: code, stdout: out }));
    });
    // The spawn ENOENT leaves no terminal pi event, so classify calls it unclassified; with the
    // probe stubbed "up" the gate proceeds immediately and the single candidate exhausts -> exit 1
    // (not the fatal-exhaustion path, exit 4 -- see D-notes in failover.ts for that distinction).
    assert.equal(status, 1);
    assert.doesNotMatch(stdout, /RESULT-OK/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test(".env that is a directory: exit 2, load error surfaced (not silently ignored)", () => {
  const { NANOGPT_API_KEY, PYKRETE_SKIP_KEY_PREFLIGHT, ...rest } = process.env;
  const envDir = mkdtempSync(join(tmpdir(), "pykrete-envcwd-"));
  mkdirSync(join(envDir, ".env"));
  const configPath = writeConfig(["good-ok"]);
  const r = spawnSync(
    "node",
    ["--experimental-strip-types", BIN, "--config", configPath, "do it"],
    { encoding: "utf-8", cwd: envDir, env: rest },
  );
  assert.equal(r.status, 2);
  assert.match(r.stderr, /failed to load \.env/);
});

test("empty shell NANOGPT_API_KEY does not shadow a valid .env value", () => {
  const { NANOGPT_API_KEY, PYKRETE_SKIP_KEY_PREFLIGHT, ...rest } = process.env;
  const key = "envkey-emptyshell-guard";
  const envDir = mkdtempSync(join(tmpdir(), "pykrete-envcwd-"));
  writeFileSync(join(envDir, ".env"), `NANOGPT_API_KEY=${key}\n`);
  const cacheRoot = seedCatalogCache(key);
  const configPath = writeConfig(["dumpenv"]);
  const r = spawnSync(
    "node",
    ["--experimental-strip-types", BIN, "--config", configPath, "do it"],
    { encoding: "utf-8", cwd: envDir, env: { ...rest, NANOGPT_API_KEY: "", PYKRETE_PI_BIN: FAKE, XDG_CACHE_HOME: cacheRoot } },
  );
  assert.equal(r.status, 0);
  assert.match(r.stdout, new RegExp(`ENVKEY=${key}\\b`));
});
