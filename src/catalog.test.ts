import { test } from "node:test";
import assert from "node:assert/strict";
import { reorder, intersects } from "./catalog.ts";

test("present ids move ahead of absent, relative order preserved", () => {
  const out = reorder(["a", "b", "c", "d"], new Set(["b", "d"]));
  assert.deepEqual(out, ["b", "d", "a", "c"]);
});

test("all-absent leaves the list complete and in order", () => {
  const out = reorder(["a", "b", "c"], new Set(["x"]));
  assert.deepEqual(out, ["a", "b", "c"]);
});

test("all-present returns the list unchanged", () => {
  const out = reorder(["a", "b"], new Set(["a", "b"]));
  assert.deepEqual(out, ["a", "b"]);
});

test("reorder never drops or adds ids", () => {
  const input = ["a", "b", "c"];
  const out = reorder(input, new Set(["b"]));
  assert.deepEqual([...out].sort(), [...input].sort());
});

test("intersects reports overlap", () => {
  assert.equal(intersects(["a", "b"], new Set(["b"])), true);
  assert.equal(intersects(["a", "b"], new Set(["x"])), false);
});

import { mkdtempSync, writeFileSync, utimesSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCatalog } from "./catalog.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "pykrete-cat-"));
}

function modelsResponse(ids: string[]): Response {
  return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });
}

async function seedCache(dir: string): Promise<string> {
  await loadCatalog({
    apiKey: "k",
    ttlSeconds: 3600,
    cacheDir: dir,
    fetchImpl: (async () => modelsResponse(["a"])) as typeof fetch,
  });
  return readdirSync(dir).find((f) => f.startsWith("catalog-") && f.endsWith(".json"))!;
}

test("missing API key -> null with a warning, no fetch", async () => {
  const warnings: string[] = [];
  let called = false;
  const out = await loadCatalog({
    apiKey: undefined,
    ttlSeconds: 3600,
    cacheDir: tmp(),
    fetchImpl: (async () => {
      called = true;
      return new Response("", { status: 200 });
    }) as typeof fetch,
    warn: (m) => warnings.push(m),
  });
  assert.equal(out, null);
  assert.equal(called, false);
  assert.equal(warnings.length, 1);
});

test("successful fetch returns ids and persists a cache file", async () => {
  const dir = tmp();
  const out = await loadCatalog({
    apiKey: "k",
    ttlSeconds: 3600,
    cacheDir: dir,
    fetchImpl: (async () => modelsResponse(["zai-org/glm-5.2", "TEE/deepseek-v4-pro:thinking"])) as typeof fetch,
  });
  assert.ok(out);
  assert.equal(out!.has("zai-org/glm-5.2"), true);
  const files = readdirSync(dir).filter((f) => f.startsWith("catalog-") && f.endsWith(".json"));
  assert.equal(files.length, 1);
});

test("fresh cache is used without a network call", async () => {
  const dir = tmp();
  // Seed: first call writes the cache.
  await loadCatalog({
    apiKey: "k",
    ttlSeconds: 3600,
    cacheDir: dir,
    fetchImpl: (async () => modelsResponse(["a", "b"])) as typeof fetch,
  });
  // Pin the cache file's mtime to a known value so the age formula is exact.
  const { createHash } = await import("node:crypto");
  const keyHash = createHash("sha256").update("k").digest("hex");
  const cacheFile = join(dir, `catalog-${keyHash}.json`);
  const mtimeSec = 500;
  utimesSync(cacheFile, mtimeSec, mtimeSec);
  // age = freshNow - mtimeSec*1000 = 1_000 ms, well within 3_600_000 ms TTL.
  const freshNow = mtimeSec * 1000 + 1_000;
  // Second call within TTL must not fetch.
  let called = false;
  const out = await loadCatalog({
    apiKey: "k",
    ttlSeconds: 3600,
    cacheDir: dir,
    now: freshNow,
    fetchImpl: (async () => {
      called = true;
      return modelsResponse(["x"]);
    }) as typeof fetch,
  });
  assert.equal(called, false);
  assert.deepEqual([...out!].sort(), ["a", "b"]);
});

test("stale cache is replaced on a successful refetch", async () => {
  const dir = tmp();
  // Seed a cache with initial ids.
  await loadCatalog({
    apiKey: "k",
    ttlSeconds: 3600,
    cacheDir: dir,
    fetchImpl: (async () => modelsResponse(["old-a", "old-b"])) as typeof fetch,
  });
  // Pin mtime and age it past the TTL.
  const { createHash } = await import("node:crypto");
  const keyHash = createHash("sha256").update("k").digest("hex");
  const cacheFile = join(dir, `catalog-${keyHash}.json`);
  const mtimeSec = 500;
  utimesSync(cacheFile, mtimeSec, mtimeSec);
  // now is 2× TTL past the mtime — clearly stale.
  const staleNow = (mtimeSec + 7200) * 1000;
  const out = await loadCatalog({
    apiKey: "k",
    ttlSeconds: 3600,
    cacheDir: dir,
    now: staleNow,
    fetchImpl: (async () => modelsResponse(["new-x", "new-y"])) as typeof fetch,
  });
  assert.ok(out);
  assert.deepEqual([...out!].sort(), ["new-x", "new-y"]);
});

test("stale cache with a failing refetch returns null (no stale fallback)", async () => {
  const dir = tmp();
  // Seed a cache file, then age its mtime well past the TTL.
  const cacheFile = join(
    dir,
    readdirSync(dir).find((f) => f.startsWith("catalog-")) ??
      (await seedCache(dir)),
  );
  // seedCache returns the relative file name; rebuild absolute path:
  const abs = cacheFile;
  utimesSync(abs, 1000, 1000); // mtime = 1000s
  const out = await loadCatalog({
    apiKey: "k",
    ttlSeconds: 3600,
    cacheDir: dir,
    now: 100_000_000, // far past mtime + ttl
    fetchImpl: (async () => {
      throw new Error("network down");
    }) as typeof fetch,
  });
  assert.equal(out, null);
});

test("empty data response is not usable and is not persisted", async () => {
  const dir = tmp();
  const warnings: string[] = [];
  const out = await loadCatalog({
    apiKey: "k",
    ttlSeconds: 3600,
    cacheDir: dir,
    fetchImpl: (async () => modelsResponse([])) as typeof fetch,
    warn: (m) => warnings.push(m),
  });
  assert.equal(out, null);
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".json")).length, 0);
  assert.equal(warnings.length, 1);
});

test("non-2xx response returns null with a warning", async () => {
  const warnings: string[] = [];
  const out = await loadCatalog({
    apiKey: "k",
    ttlSeconds: 3600,
    cacheDir: tmp(),
    fetchImpl: (async () => new Response("nope", { status: 503 })) as typeof fetch,
    warn: (m) => warnings.push(m),
  });
  assert.equal(out, null);
  assert.equal(warnings.length, 1);
});

test("corrupt fresh cache falls through to a fetch", async () => {
  const dir = tmp();
  // Hand-write a corrupt cache file at the exact path loadCatalog will look for.
  const { createHash } = await import("node:crypto");
  const keyHash = createHash("sha256").update("k").digest("hex");
  const cacheFile = join(dir, `catalog-${keyHash}.json`);
  writeFileSync(cacheFile, "{ not json");
  utimesSync(cacheFile, 999, 999);
  const out = await loadCatalog({
    apiKey: "k",
    ttlSeconds: 3600,
    cacheDir: dir,
    now: 999 * 1000 + 100, // fresh by mtime
    fetchImpl: (async () => modelsResponse(["recovered"])) as typeof fetch,
  });
  assert.equal(out!.has("recovered"), true);
});
