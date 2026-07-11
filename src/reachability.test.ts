// src/reachability.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { probeNanoGpt } from "./reachability.ts";

function fetchReturning(status: number): typeof fetch {
  return (async () => ({ ok: status >= 200 && status < 300, status })) as unknown as typeof fetch;
}

test("200 -> up", async () => {
  assert.equal(await probeNanoGpt({ fetchImpl: fetchReturning(200), apiKey: "k" }), "up");
});

test("401 and 403 -> down (the /models probe is public and cannot see auth; AR-2)", async () => {
  // Spike AR-2: /models returns 200 regardless of key, so a real bad key never shows here — it is
  // caught by classify on the inference 401 (-> fatal). A hypothetical non-2xx from /models means we
  // could not confirm reachability, so treat it as down (a conservative outage signal), never auth.
  assert.equal(await probeNanoGpt({ fetchImpl: fetchReturning(401), apiKey: "k" }), "down");
  assert.equal(await probeNanoGpt({ fetchImpl: fetchReturning(403), apiKey: "k" }), "down");
});

test("429 -> throttled (reachable but rate-limited; distinct from down)", async () => {
  assert.equal(await probeNanoGpt({ fetchImpl: fetchReturning(429), apiKey: "k" }), "throttled");
});

test("500 and other non-2xx -> down", async () => {
  assert.equal(await probeNanoGpt({ fetchImpl: fetchReturning(503), apiKey: "k" }), "down");
  assert.equal(await probeNanoGpt({ fetchImpl: fetchReturning(500), apiKey: "k" }), "down");
});

test("fetch rejection (DNS/connection) -> down", async () => {
  const reject = (async () => { throw new Error("ENOTFOUND"); }) as unknown as typeof fetch;
  assert.equal(await probeNanoGpt({ fetchImpl: reject, apiKey: "k" }), "down");
});

test("timeout aborts and maps to down", async () => {
  const hang: typeof fetch = ((_url: string, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as unknown as typeof fetch;
  assert.equal(await probeNanoGpt({ fetchImpl: hang, apiKey: "k", timeoutMs: 20 }), "down");
});

test("passes the bearer token", async () => {
  let seen: string | undefined;
  const spy: typeof fetch = ((_url: string, init?: { headers?: Record<string, string> }) => {
    seen = init?.headers?.Authorization;
    return Promise.resolve({ ok: true, status: 200 });
  }) as unknown as typeof fetch;
  await probeNanoGpt({ fetchImpl: spy, apiKey: "secret" });
  assert.equal(seen, "Bearer secret");
});

test("url override targets the given endpoint (default is MODELS_URL)", async () => {
  let seen = "";
  const spy: typeof fetch = ((url: string) => { seen = url; return Promise.resolve({ ok: true, status: 200 }); }) as unknown as typeof fetch;
  await probeNanoGpt({ fetchImpl: spy, apiKey: "k", url: "http://127.0.0.1:9/models" });
  assert.equal(seen, "http://127.0.0.1:9/models");
});
