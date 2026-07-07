# Liveness & Resume Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a transport-liveness layer over Spec B's failover machine that catches a clean-but-incomplete run (silent stop) via a sentinel nonce and resumes it, kills a stuck stream via an idle watchdog, and rides out a NanoGPT/network outage with paused-deadline backoff instead of cascading — without Pykrete ever inspecting task content.

**Architecture:** Three new pure/thin modules (`nonce.ts`, `reachability.ts`) plus one new per-candidate orchestrator (`runCandidate.ts`) that wraps the existing single-process `launch.ts`. `classify.ts` gains an `incomplete` verdict; `failover.ts` swaps its inline launch+classify for a `runCandidate` call and learns to pause the deadline during outage backoff; `bin/pykrete.ts` owns per-run session-dir lifecycle and wires real timers/fetch as injected dependencies. Every unit keeps one responsibility and every impure edge (sleep, now, fetch, spawn) is injected so tests are fast and deterministic.

**Tech Stack:** TypeScript run via `node --experimental-strip-types`; tests with `node:test` + `node:assert/strict`; strict `tsc --noEmit`; no new runtime dependencies (reuses `node:crypto`, `node:fs`, global `fetch`).

## Global Constraints

- **Contract 06-05 (binding):** Pykrete does NOT infer, decompose, plan, or verdict-gate tasks. The nonce is an opaque liveness marker, never content inspection. The resume prompt carries ZERO worktree state (no file lists, diffs, missing-paths, or test results).
- **pi version pin:** build and validate against `pi@0.80.3` (`@earendil-works/pi-coding-agent`). Documented pin only — no runtime version assertion.
- **Reliability is the prime directive:** only genuine model-unavailability may stop a run early (exit 4). Outages wait; stalls fail over or resume; nothing fakes success.
- **Nonce source:** `crypto.randomBytes(8).toString("hex")` (16 hex chars). Never `Math.random`.
- **Exit-code contract (unchanged from Spec B):** `0` lead success (incl. after resume), `3` substituted success (incl. after resume), `4` all candidates *cleanly* model-unavailable, `1` fatal / transient / post-output death / incomplete-after-resume / outage give-up / bad-key (inference 401 → classify fatal) / deadline / mixed exhaustion, `2` bad args / missing prompt / config error.
- **Backoff ladder (internal constants, not config):** base `1_000 ms`, factor `2`, cap `1_024_000 ms` → 1,2,4,…,1024 s. A probe result of `down`/timeout **or** `throttled` (429) both enter this ladder; `up` proceeds. A bad key is NOT a probe state (spike AR-2: `/models` is public) — it is caught by `classify` (inference `401 → fatal`). A per-candidate `MAX_OUTAGE_RETRIES = 10` backstop bounds a flapping network (recover→relaunch→re-outage) that would otherwise loop forever without spending resume budget.
- **Probe timeout (internal constant):** `4_000 ms`.
- **Idle watchdog must sit OUTSIDE pi's HTTP idle window.** pi's undici `bodyTimeout`/`headersTimeout` default to `DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000` (verified: `packages/coding-agent/src/core/http-dispatcher.ts:3`) — a single stream can be silent on stdout for ~300 s before pi aborts and self-retries. Pykrete's idle default is therefore **330 s**, so pi's own abort/self-heal fires first and the watchdog only kills a stream pi has genuinely abandoned. A shorter idle would false-kill slow-but-alive streams and undercut pi's self-retry (a reliability regression).
- **All timing/network/randomness is injected** (`sleep`, `now`, `fetchImpl`, spawn via `piBin`) so tests never touch the wall clock or the network.
- **TDD, DRY, YAGNI, frequent commits.** Match existing file style (2-space indent, explanatory comments on non-obvious guards).

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/nonce.ts` | **new** | `mintNonce`, `buildSuffix`, `buildResumePrompt`, `noncePresent`, `stripSentinel` — pure string functions |
| `src/reachability.ts` | **new** | `probeNanoGpt(deps) → "up" \| "down" \| "throttled"` — one timed `/models` GET (no `auth`: `/models` is public, spike AR-2) |
| `src/runCandidate.ts` | **new** | One candidate's full lifecycle: nonce injection, launch, nonce/idle gate, bounded `--continue` resume loop, reachability-gated backoff. Returns a `CandidateResult` |
| `src/launch.ts` | modify | Idle watchdog + `idledOut` flag on `AttemptOutcome`; `--session-dir`/`--continue` support; drop hard-coded `--no-session` |
| `src/pi-events.ts` | modify | Expose `terminalText` (terminal-block text) so the nonce gate reads the genuinely-final block (review fix E) |
| `src/classify.ts` | modify | Optional `noncePresent` input; new `incomplete` verdict for clean-stop-without-nonce |
| `src/failover.ts` | modify | Call `runCandidate`; map `CandidateResult`; pause the deadline by accumulated `pausedMs` |
| `src/config.ts` | modify | New `[liveness]` block + `LivenessConfig` on `Config` |
| `src/cli.ts` | modify | Surface `config.liveness` on `RunResult` so `bin` can thread it |
| `bin/pykrete.ts` | modify | Per-run session-dir temp lifecycle + cleanup; construct `runCandidate` deps with real fetch/sleep/timers |
| `src/test-fixtures/fake-pi.mjs` | modify | Add an `idlepost` scenario (output then hang) for the idle-watchdog launch test |

**Dependency DAG:** Task 0 (spike) → 1 (nonce) → 2 (reachability) → 3 (classify) → 4 (launch) → 5 (config/cli) → 6 (runCandidate, needs 1–4) → 7 (failover, needs 6) → 8 (bin, needs 5–7).

---

### Task 0: De-risk spike (live pi@0.80.3 validation) — GATE, no production code

This task writes NO production code. It is a throwaway live run whose findings can veto or adjust every later task. Do not proceed to Task 1 until its acceptance checklist is recorded.

**Files:**
- Create: `docs/superpowers/specs/2026-07-07-liveness-resume-spike-findings.md` (findings note, committed)

**Interfaces:**
- Produces: confirmed facts consumed by Task 3 (real error-message shape → `parseStatus`/`modelReferenced` reconciliation), Task 4 (does pi emit stdout per internal retry → idle threshold sanity), Task 6 (session `--continue` round-trip works).

- [ ] **Step 1: Confirm pi version**

Run: `pi --version` (or `npx --no-install @earendil-works/pi-coding-agent --version`)
Expected: `0.80.3`. If not, install/pin it before continuing; a different version invalidates the spike.

- [ ] **Step 2: Session `--continue` round-trip**

Run a throwaway two-step session against a real cheap model, e.g.:
```bash
SD=$(mktemp -d)
pi -p --mode json --offline --provider nanogpt --model <cheap-model> --session-dir "$SD" \
  "Remember the codeword BANANA. Reply only: ok." | tail -5
pi -p --mode json --offline --provider nanogpt --model <cheap-model> --session-dir "$SD" --continue \
  "What was the codeword?" | tail -5
```
Expected: the second run's assistant text contains `BANANA` — proving session context survives the process boundary. Record the exact final `message_end`/`turn_end` JSON envelope shape. **Also `ls -la "$SD"` and record the session artifact filename(s)** — `sessionReady()` (Task 8) proxies "pi wrote resumable state" as a `.jsonl` in the dir. If pi 0.80.3 writes a different extension (`.json`, `.log`, a subdir), `sessionReady()` would always return false and every silent-stop resume would wrongly become a partial — so if the extension differs, propagate the corrected check to Task 8 before building.

- [ ] **Step 3: Nonce suffix round-trip**

Append the `buildSuffix` block (from Task 1's §1 text) to a trivial prompt and run once. Confirm the final assistant text block ends with `WORK COMPLETE <the-nonce>`. Record whether pi pads/reformats the message `content` in `--mode json` (spike check (f) — commits `6564d947`/`9be55bc7`). Confirm a `.trim()`-tolerant substring match would still find the marker.

- [ ] **Step 4: Per-retry stdout behaviour AND the HTTP idle window (D1)**

Provoke a transient (e.g. a momentarily bad base URL or an over-long prompt that rate-limits) and watch stdout. Record whether pi emits ANY JSON line per internal retry attempt (its 2/4/8s agent-session backoff should emit `auto_retry_start`). Separately, confirm the HTTP idle window: pi's undici `bodyTimeout`/`headersTimeout` default to `DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000` (`packages/coding-agent/src/core/http-dispatcher.ts:3`). Verify a single streaming request can be silent on stdout up to ~300s before pi aborts+self-retries. This is why the idle default is **330s** (outside the 300s window). If the spike shows pi emits stream-progress events frequently enough that 300s silence never actually happens, note it — the 330s default can then be revisited. Do NOT lower the idle default below ~330s without this evidence.

- [ ] **Step 4b: Non-terminal nonce / empty-final-turn (D3)**

Check whether, in `--mode json`, pi can emit the `WORK COMPLETE <nonce>` marker in a non-terminal `message_update` and then a terminal `message_end` with empty/different content — because `pi-events.ts`'s accumulator keeps `text = last-non-empty assistant turn`, an empty terminal turn would preserve the earlier marker and make `noncePresent` true without a genuine final-block completion. Per the D3 decision the nonce only counts on a clean terminal stop, so this is mostly guarded, but confirm the accumulator's `text` reflects the genuinely-final assistant block. If pi routinely splits the final message such that the marker lands in a non-terminal block, flag it — `classify` (which reads np only on `stop`/`length`) plus the accumulator must together yield "marker in the block that carried the terminal `stop`".

- [ ] **Step 5: Real error-message shape (REQUIRED reconciliation)**

Capture two real error envelopes: (a) a bogus model id (model-unavailable), (b) a deliberately bad `NANOGPT_API_KEY` (401/403). For each, record the exact `errorMessage` string. Then answer:
- Does the status code still lead the string (does `parseStatus`'s `/^\s*(\d{3})\b/` still match), given commit `62fad94f`'s new `"<status>: <body-json>"` format?
- Does `modelReferenced` still fire — does the model id / the words "model" + "not supported/does not exist" still appear, now that the body is JSON not prose?
- Does the 401/403 come back as an HTTP status the reachability probe's `res.status` sees (Task 2), or only inside the streamed `errorMessage`? **Spike outcome (AR-2):** only inside the inference `errorMessage` (`401: {…invalid_api_key…}` → classify `fatal`). The `/models` probe never sees it — see Step 6.

- [ ] **Step 6: Probe endpoint**

Run: `curl -sS -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $NANOGPT_API_KEY" 'https://nano-gpt.com/api/v1/models?detailed=true'`
Expected: `200`. Repeat with a bad key; record the status. This was load-bearing for the Task 2 auth mapping. **Spike outcome (AR-2):** `/models` is a **public** endpoint — it returned `200` with a valid key, no key, and a bogus key alike, so the probe can NEVER detect a bad key and there is no error body worth parsing. Task 2 therefore drops the `auth` state entirely (enum `up | down | throttled`); bad-key detection lives in `classify` (inference `401 → fatal`). Also note whether `/models` is rate-limited (`429`) independently of inference — this informs the `throttled`→backoff mapping (D6): a `/models` endpoint that 429s easily while inference is fine means the backoff will sometimes wait on a phantom throttle. **Spike outcome:** no `429` under a 30-way concurrent burst, so the phantom-throttle risk at real probe cadence is negligible.

- [ ] **Step 7: Record findings and commit**

Write each result into the findings note under headings matching the steps. Explicitly flag any assumption that FAILED and what Task 3/4/6 must change. Commit:
```bash
git add docs/superpowers/specs/2026-07-07-liveness-resume-spike-findings.md
git commit -m "docs: liveness/resume de-risk spike findings (pi@0.80.3)"
```

**Acceptance:** all six steps recorded; the classify reconciliation (Step 5) has a definite yes/no per predicate. If any core assumption (session `--continue`, nonce round-trip) failed, STOP and escalate — the resume machinery is not viable as specified.

---

### Task 1: nonce.ts (sentinel primitives)

**Files:**
- Create: `src/nonce.ts`
- Test: `src/nonce.test.ts`

**Interfaces:**
- Produces:
  - `mintNonce(): string` — 16 lowercase hex chars.
  - `buildSuffix(nonce: string): string` — first-attempt prompt suffix.
  - `buildResumePrompt(nonce: string): string` — Contract-06-05-stripped resume prompt (spec §7).
  - `noncePresent(finalText: string, nonce: string): boolean` — final text block contains `WORK COMPLETE <nonce>` (trim-tolerant substring).
  - `stripSentinel(text: string, nonce: string): string` — removes the marker line(s) before emit.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/nonce.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mintNonce, buildSuffix, buildResumePrompt, noncePresent, stripSentinel } from "./nonce.ts";

test("mintNonce is 16 lowercase hex chars", () => {
  const n = mintNonce();
  assert.match(n, /^[0-9a-f]{16}$/);
  assert.notEqual(mintNonce(), mintNonce()); // effectively never collides
});

test("buildSuffix embeds the exact marker phrase and a do-not-write-to-file fence", () => {
  const s = buildSuffix("abc123abc123abcd");
  assert.match(s, /WORK COMPLETE abc123abc123abcd/);
  assert.match(s, /not write it to any file|Do NOT write it to any file/i);
});

test("buildResumePrompt is status-only: no diff/file/test words, carries the marker", () => {
  const p = buildResumePrompt("abc123abc123abcd");
  assert.match(p, /WORK COMPLETE abc123abc123abcd/);
  assert.doesNotMatch(p, /diff|git|test failure|files? written|missing/i);
});

test("noncePresent true only when the final text contains the exact marker", () => {
  const n = "deadbeefdeadbeef";
  assert.equal(noncePresent(`all done.\nWORK COMPLETE ${n}`, n), true);
  assert.equal(noncePresent(`  WORK COMPLETE ${n}  \n`, n), true); // trim-tolerant
  assert.equal(noncePresent("WORK COMPLETE 0000000000000000", n), false); // wrong nonce
  assert.equal(noncePresent("still working, no marker", n), false);
});

test("stripSentinel removes exactly the marker line, leaves the rest", () => {
  const n = "deadbeefdeadbeef";
  assert.equal(stripSentinel(`hello world\nWORK COMPLETE ${n}`, n), "hello world");
  assert.equal(stripSentinel("no marker here", n), "no marker here");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --experimental-strip-types --test src/nonce.test.ts`
Expected: FAIL — `Cannot find module './nonce.ts'`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/nonce.ts
import { randomBytes } from "node:crypto";

// 8 bytes -> 16 hex chars, matching the ancestor bench's secrets.token_hex(8).
export function mintNonce(): string {
  return randomBytes(8).toString("hex");
}

// Appended to the caller's prompt on the FIRST attempt only. Instructs the model to end its final
// message with the exact marker, and fences it as a liveness-only token that must never be written
// to a file (guards the bench's H2 chain where models echoed injected text into deliverables).
export function buildSuffix(nonce: string): string {
  return [
    "",
    "---",
    "When the task is genuinely complete, end your final message with exactly this line:",
    `WORK COMPLETE ${nonce}`,
    "This line is a liveness marker only. Do NOT write it to any file or include it in any output.",
  ].join("\n");
}

// Sent on a --continue resume. Status-only: carries NO worktree state (Contract 06-05). The nonce is
// reused (it already lives in session history from the first attempt), not regenerated.
export function buildResumePrompt(nonce: string): string {
  return [
    "Your previous session stopped, but the task may not be complete. This block is",
    "status only — do NOT write it to any file. If the task is incomplete, continue.",
    "If it is genuinely complete, end your final message with exactly:",
    `WORK COMPLETE ${nonce}`,
    "and then stop.",
  ].join("\n");
}

// Presence = the FINAL assistant text block contains the exact marker. Substring + trim, so pi's
// configurable --mode json output padding (commit 6564d947) cannot break an exact-equals check.
export function noncePresent(finalText: string, nonce: string): boolean {
  return finalText.trim().includes(`WORK COMPLETE ${nonce}`);
}

// Remove the marker line(s) so stdout never leaks the liveness token to the caller.
export function stripSentinel(text: string, nonce: string): string {
  const marker = `WORK COMPLETE ${nonce}`;
  return text
    .split("\n")
    .filter((line) => !line.includes(marker))
    .join("\n")
    .trimEnd();
}
```

- [ ] **Step 4: Run to verify pass + typecheck**

Run: `node --experimental-strip-types --test src/nonce.test.ts && npx tsc --noEmit`
Expected: PASS (5 tests), no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/nonce.ts src/nonce.test.ts
git commit -m "feat: nonce sentinel primitives (mint/suffix/resume/present/strip)"
```

---

### Task 2: reachability.ts (NanoGPT probe)

**Files:**
- Create: `src/reachability.ts`
- Modify: `src/catalog.ts:18` (export the `MODELS_URL` constant so the probe reuses it — DRY)
- Test: `src/reachability.test.ts`

**Interfaces:**
- Consumes: `MODELS_URL` from `catalog.ts`.
- Produces:
  - `type Reachability = "up" | "down" | "throttled"` — no `auth`: the spike (AR-2) found `/models` is a **public** endpoint (200 with any/no/bogus key), so the probe cannot detect a bad key. Bad-key detection lives in `classify` (the inference `401 → fatal`, classify.ts), not the probe.
  - `probeNanoGpt(deps: ReachabilityDeps): Promise<Reachability>` where `ReachabilityDeps = { fetchImpl: typeof fetch; apiKey: string | undefined; timeoutMs?: number }`.
  - `throttled` (HTTP 429) is distinct from `down`: the metadata endpoint is rate-limited but the service is reachable + authed, so it must never be counted as a hard outage (never exit 4). Per the D6 decision it still triggers the exponential backoff (rate-limiting warrants backing off), via the same ladder as `down` — the caller (`runCandidate`'s gate) folds both into the wait loop with distinct diagnostics.

- [ ] **Step 1: Export MODELS_URL from catalog.ts**

Change `src/catalog.ts:18` from:
```typescript
const MODELS_URL = "https://nano-gpt.com/api/v1/models?detailed=true";
```
to:
```typescript
export const MODELS_URL = "https://nano-gpt.com/api/v1/models?detailed=true";
```
(No other catalog change; the local usage on line 58 still resolves.)

- [ ] **Step 2: Write the failing tests**

```typescript
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
```

- [ ] **Step 3: Run to verify they fail**

Run: `node --experimental-strip-types --test src/reachability.test.ts`
Expected: FAIL — `Cannot find module './reachability.ts'`.

- [ ] **Step 4: Write the implementation**

```typescript
// src/reachability.ts
import { MODELS_URL } from "./catalog.ts";

export type Reachability = "up" | "down" | "throttled";

export interface ReachabilityDeps {
  fetchImpl: typeof fetch;
  apiKey: string | undefined;
  timeoutMs?: number;
}

const DEFAULT_PROBE_TIMEOUT_MS = 4_000;

// A single GET /models is a cheap, already-plumbed proxy for /chat/completions reachability.
// Spike AR-2: /models is a PUBLIC endpoint (200 with any/no/bogus key), so the probe cannot detect a
// bad key — auth is caught by classify on the inference 401. The probe reports reachability only:
// up (200) / throttled (429) / down (everything else). Accepted limitation: the metadata gateway
// being up does not 100% guarantee inference is up.
export async function probeNanoGpt(deps: ReachabilityDeps): Promise<Reachability> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await deps.fetchImpl(MODELS_URL, {
      headers: { Authorization: `Bearer ${deps.apiKey ?? ""}` },
      signal: controller.signal,
    });
    if (res.status === 429) return "throttled"; // reachable but rate-limited (D6): back off, don't cascade
    if (res.ok) return "up";
    return "down"; // any 5xx / 4xx / other non-2xx: could not confirm reachability
  } catch {
    return "down"; // timeout (abort), DNS, connection reset
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 5: Run to verify pass + typecheck**

Run: `node --experimental-strip-types --test src/reachability.test.ts src/catalog.test.ts && npx tsc --noEmit`
Expected: PASS (reachability tests + unchanged catalog tests), no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/reachability.ts src/reachability.test.ts src/catalog.ts
git commit -m "feat: NanoGPT reachability probe (up/down/throttled) reusing MODELS_URL"
```

---

### Task 3: classify.ts (nonce-aware success + incomplete verdict)

**Files:**
- Modify: `src/classify.ts`
- Test: `src/classify.test.ts` (add cases)

**Interfaces:**
- Consumes: nothing new (takes a plain `boolean | undefined`).
- Produces:
  - `Verdict` union gains `| { kind: "incomplete"; message: string }`.
  - `classify(outcome, flags, noncePresent?: boolean): Verdict` — new optional third arg. `undefined` ⇒ nonce disabled ⇒ Spec B behaviour.

**NOTE (from Task 0):** if the spike's Step 5 found `parseStatus`/`modelReferenced` no longer match pi 0.80.3's `"<status>: <body-json>"` error string, fix those here in the same task (add a step) before the nonce work. Do not skip that reconciliation.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/classify.test.ts — ADD these (keep existing cases)
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify } from "./classify.ts";
import type { PiRunOutcome } from "./pi-events.ts";

const flags = { startupTimedOut: false, overallTimedOut: false };
function oc(o: Partial<PiRunOutcome>): PiRunOutcome {
  return { text: "", terminalText: "", sawAssistantOutput: false, ...o };
}

test("clean stop + noncePresent:true -> success", () => {
  assert.deepEqual(classify(oc({ stopReason: "stop" }), flags, true), { kind: "success" });
});

test("clean stop + noncePresent:false -> incomplete", () => {
  const v = classify(oc({ stopReason: "stop" }), flags, false);
  assert.equal(v.kind, "incomplete");
});

test("length stop + noncePresent:false -> incomplete", () => {
  const v = classify(oc({ stopReason: "length" }), flags, false);
  assert.equal(v.kind, "incomplete");
});

test("clean stop + noncePresent:undefined (nonce disabled) -> success (Spec B parity)", () => {
  assert.deepEqual(classify(oc({ stopReason: "stop" }), flags), { kind: "success" });
});

test("noncePresent is ignored for a non-stop error verdict", () => {
  const v = classify(oc({ stopReason: "error", model: "m", errorMessage: "404 not_found_error" }), flags, false);
  assert.equal(v.kind, "model-unavailable");
});

// D10: pin pi 0.80.3's real "<status>: <body-json>" error shape (commit 62fad94f, no-prefix branch of
// formatProviderError). Update these literals to the EXACT strings the Task 0 spike (Step 5) captured
// from NanoGPT before writing — the shapes below are the confirmed format, not a guess.
test("0.80.3 colon-form: 404 JSON body -> model-unavailable", () => {
  const msg = `404: {"error":{"message":"The model \`x\` does not exist","code":"model_not_found"}}`;
  const v = classify(oc({ stopReason: "error", model: "x", errorMessage: msg }), flags, false);
  assert.equal(v.kind, "model-unavailable");
});

test("0.80.3 colon-form: 401 JSON body -> fatal", () => {
  const msg = `401: {"error":{"message":"Invalid API key","code":"invalid_api_key"}}`;
  const v = classify(oc({ stopReason: "error", errorMessage: msg }), flags, false);
  assert.equal(v.kind, "fatal");
});

test("0.80.3 colon-form: 429 JSON body -> transient", () => {
  const msg = `429: {"error":{"message":"Rate limit exceeded","code":"rate_limit"}}`;
  const v = classify(oc({ stopReason: "error", errorMessage: msg }), flags, false);
  assert.equal(v.kind, "transient");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --experimental-strip-types --test src/classify.test.ts`
Expected: FAIL — `classify` takes 2 args / `incomplete` not produced.

- [ ] **Step 3: Modify the implementation**

Add `incomplete` to the union at the top of `src/classify.ts`:
```typescript
export type Verdict =
  | { kind: "success" }
  | { kind: "incomplete"; message: string }
  | { kind: "model-unavailable" }
  | { kind: "fatal"; message: string }
  | { kind: "transient"; message: string }
  | { kind: "ambiguous"; message: string };
```

Change the `classify` signature and the stop/length branch. Replace the current signature line and the single `stop`/`length` line:
```typescript
export function classify(
  outcome: PiRunOutcome,
  flags: { startupTimedOut: boolean; overallTimedOut: boolean },
  noncePresent?: boolean,
): Verdict {
```
and replace:
```typescript
  if (stopReason === "stop" || stopReason === "length") return { kind: "success" };
```
with:
```typescript
  // A clean terminal stop is success ONLY if the liveness nonce is present (or the nonce is disabled,
  // i.e. noncePresent === undefined -> Spec B behaviour). A clean stop with the nonce missing is a
  // silent-stop (S1): the model quit cleanly but never signalled completion -> drive a resume.
  if (stopReason === "stop" || stopReason === "length") {
    if (noncePresent === false) return { kind: "incomplete", message: "clean stop without completion nonce" };
    return { kind: "success" };
  }
```
Everything else in `classify` is unchanged.

- [ ] **Step 4: Run to verify pass + typecheck**

Run: `node --experimental-strip-types --test src/classify.test.ts && npx tsc --noEmit`
Expected: PASS (new + existing cases). Note: `tsc` may now flag `failover.ts` (it calls `classify` and switches on `Verdict`) — that is expected and fixed in Task 7. If so, run only the test command here and defer the full `tsc` to Task 7.

- [ ] **Step 5: Commit**

```bash
git add src/classify.ts src/classify.test.ts
git commit -m "feat: nonce-aware classify with incomplete verdict for silent stops"
```

---

### Task 4: launch.ts (idle watchdog + session flags)

**Files:**
- Modify: `src/launch.ts`
- Modify: `src/test-fixtures/fake-pi.mjs` (add `idlepost` scenario)
- Test: `src/launch.test.ts` (add cases)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `AttemptOutcome` gains `idledOut: boolean`.
  - `LaunchOptions` gains `idleTimeoutMs?: number`, `sessionDir?: string`, `continueSession?: boolean`.
  - Spawned argv: `--no-session` removed; `--session-dir <dir>` added when `sessionDir` set; `--continue` added when `continueSession` true; prompt stays last.

- [ ] **Step 1: Add the `idlepost` fake-pi scenario**

In `src/test-fixtures/fake-pi.mjs`, add a branch (before the final `else`):
```javascript
} else if (model.includes("idlepost")) {
  // Emit output then hang -> post-output idle stall (sawAssistantOutput true, no terminal event).
  emit({ type: "agent_start" });
  emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "THINKING" }] } });
  setTimeout(() => {}, 10_000);
```

- [ ] **Step 2: Write the failing tests**

```typescript
// src/launch.test.ts — ADD these (keep existing cases)
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
```

Also add the `dumpargs` scenario to `fake-pi.mjs` (before the final `else`):
```javascript
} else if (model.includes("dumpargs")) {
  emit({ type: "agent_start" });
  assistant({ content: [{ type: "text", text: argv.join(" ") }], stopReason: "stop" });
```

- [ ] **Step 3: Run to verify they fail**

Run: `node --experimental-strip-types --test src/launch.test.ts`
Expected: FAIL — `idledOut` undefined; `--session-dir` not in argv; `--no-session` still present.

- [ ] **Step 4: Modify launch.ts — argv, options, outcome field**

In `LaunchOptions` add:
```typescript
  idleTimeoutMs?: number;
  sessionDir?: string;
  continueSession?: boolean;
```
In `AttemptOutcome` add:
```typescript
  idledOut: boolean;
```
Replace the fixed `args` array with (drops `--no-session`, adds session flags, prompt last):
```typescript
  const args = ["-p", "--mode", "json", "--offline", "--provider", "nanogpt", "--model", opts.candidate];
  if (opts.sessionDir !== undefined) args.push("--session-dir", opts.sessionDir);
  if (opts.continueSession) args.push("--continue");
  args.push(opts.prompt);
```

- [ ] **Step 5: Modify launch.ts — idle watchdog**

Add `let idledOut = false;` next to the other `let` flags. Add a reschedule-on-line idle timer. Below the existing `overallTimer` declaration, add:
```typescript
    // Idle watchdog: armed on the first stdout line, reset by every subsequent line. Fires when the
    // stream has been silent for longer than idleTimeoutMs. Covers the post-agent_start window the
    // startup watchdog disarms. The threshold (default 330s from config) must sit OUTSIDE pi's own
    // 300s HTTP idle window (undici body/headers timeout) so pi aborts + self-retries a silent stream
    // FIRST; the watchdog only reclaims a stream pi has genuinely abandoned. pi's agent-session retry
    // backoff (2/4/8s) emits visible stdout events that reset lastEventAt, so it is not the threat —
    // the 300s HTTP idle window is.
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const bumpIdle = () => {
      if (opts.idleTimeoutMs === undefined) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idledOut = true;
        escalate();
      }, opts.idleTimeoutMs);
    };
```
In the `rl.on("line", ...)` handler, after `lastEventAt = Date.now();`, add `bumpIdle();`. In `finish(...)`, after `if (heartbeatTimer) clearInterval(heartbeatTimer);` add `if (idleTimer) clearTimeout(idleTimer);`. Add `idledOut` to the `resolve({ ... })` object:
```typescript
      resolve({ outcome: acc.result(), startupTimedOut, overallTimedOut, idledOut, exitCode, signal, stderr });
```

- [ ] **Step 6: Run to verify pass + typecheck**

Run: `node --experimental-strip-types --test src/launch.test.ts && npx tsc --noEmit`
Expected: launch tests PASS. `tsc` may flag `failover.test.ts`/`failover.ts` for the missing `idledOut` in their `outcome(...)` helper — expected, fixed in Task 7. Defer full `tsc` to Task 7 if so.

- [ ] **Step 7: Commit**

```bash
git add src/launch.ts src/launch.test.ts src/test-fixtures/fake-pi.mjs
git commit -m "feat: idle watchdog + session-dir/--continue flags in launch; drop --no-session"
```

---

### Task 4b: pi-events.ts (terminal-block nonce text) — review pass fix E/Q2

**Files:**
- Modify: `src/pi-events.ts`
- Test: `src/pi-events.test.ts` (add cases)

**Interfaces:**
- Produces: `PiRunOutcome` gains `terminalText: string` — the text of the terminal (`message_end`/`turn_end`) assistant block specifically. `text` (last non-empty turn, used for emission) is unchanged.

**Why:** `noncePresent` must read the GENUINELY-final block. The accumulator keeps `text = last non-empty assistant turn`, so a nonce emitted in a non-terminal `message_update` followed by an empty terminal turn would survive in `text` and read as success (review finding E). Exposing the terminal block's text separately lets `runCandidate` gate the nonce on it. Depends on the spike (Task 0 Step 4b) confirming pi's `message_end`/`turn_end` carries the final answer text (the fixtures and real `ping.jsonl` show it does).

- [ ] **Step 1: Write the failing tests**

```typescript
// src/pi-events.test.ts — ADD these (keep existing cases)
test("terminalText captures the terminal block's text, not a non-terminal update", () => {
  const r = feed([
    `{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"WORK COMPLETE abc"}]}}`,
    `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"final answer"}],"stopReason":"stop"}}`,
  ]);
  assert.equal(r.terminalText, "final answer");
  assert.equal(r.text, "final answer"); // last non-empty turn also happens to be terminal here
});

test("a nonce in a non-terminal block with an EMPTY terminal turn does NOT survive in terminalText", () => {
  const r = feed([
    `{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"WORK COMPLETE abc"}]}}`,
    `{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"stop"}}`,
  ]);
  assert.equal(r.text, "WORK COMPLETE abc"); // preserved for emission (last non-empty turn)
  assert.equal(r.terminalText, "");          // but the TERMINAL block was empty -> nonce cannot count
});

test("terminalText defaults to empty when no terminal event arrives", () => {
  const r = feed([`{"type":"message_start","message":{"role":"assistant","content":[{"type":"text","text":"x"}]}}`]);
  assert.equal(r.terminalText, "");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --experimental-strip-types --test src/pi-events.test.ts`
Expected: FAIL — `r.terminalText` undefined.

- [ ] **Step 3: Modify pi-events.ts**

Add `terminalText: string` to `PiRunOutcome`. In `createPiEventsAccumulator`, add `let terminalText = "";`. In `handleAssistant`, after the existing `if (turnText.length > 0) { sawAssistantOutput = true; text = turnText; }`, add:
```typescript
    // The nonce liveness gate must read the genuinely-final block. Capture the terminal message's
    // text separately; only overwrite on a NON-EMPTY terminal turn so a trailing empty turn_end after
    // a text-bearing message_end does not erase it.
    if (terminal && turnText.length > 0) terminalText = turnText;
```
Add `terminalText` to the `result()` return object.

- [ ] **Step 4: Run to verify pass + typecheck**

Run: `node --experimental-strip-types --test src/pi-events.test.ts && npx tsc --noEmit`
Expected: pi-events tests PASS. (`tsc` may flag `classify.test.ts`/`runCandidate.test.ts` helpers until their `PiRunOutcome` literals add `terminalText` — those helpers are updated in Tasks 3 and 6.)

- [ ] **Step 5: Commit**

```bash
git add src/pi-events.ts src/pi-events.test.ts
git commit -m "feat: expose terminalText so the nonce gate reads the genuinely-final block"
```

---

### Task 5: config.ts + cli.ts ([liveness] block and threading)

**Files:**
- Modify: `src/config.ts`
- Modify: `src/cli.ts`
- Test: `src/config.test.ts` (add cases)

**Interfaces:**
- Produces:
  - `interface LivenessConfig { nonceEnabled: boolean; idleTimeoutSeconds: number; resumeAttempts: number }`
  - `Config` gains `liveness: LivenessConfig`.
  - `RunResult` (cli.ts) gains `liveness: LivenessConfig`.
- Defaults: `nonceEnabled=true`, `idleTimeoutSeconds=330`, `resumeAttempts=1`.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/config.test.ts — ADD these (keep existing cases)
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig, ConfigError } from "./config.ts";

const baseCfg = { default_family: "glm", families: { glm: ["a"] } };

test("liveness defaults when [liveness] omitted", () => {
  const c = parseConfig(baseCfg);
  assert.deepEqual(c.liveness, { nonceEnabled: true, idleTimeoutSeconds: 330, resumeAttempts: 1 });
});

test("liveness values are read and typed", () => {
  const c = parseConfig({ ...baseCfg, liveness: { nonce_enabled: false, idle_timeout_seconds: 90, resume_attempts: 2 } });
  assert.deepEqual(c.liveness, { nonceEnabled: false, idleTimeoutSeconds: 90, resumeAttempts: 2 });
});

test("liveness.idle_timeout_seconds must be a positive integer", () => {
  assert.throws(() => parseConfig({ ...baseCfg, liveness: { idle_timeout_seconds: 0 } }), ConfigError);
});

test("liveness.resume_attempts may be 0 but not negative", () => {
  assert.equal(parseConfig({ ...baseCfg, liveness: { resume_attempts: 0 } }).liveness.resumeAttempts, 0);
  assert.throws(() => parseConfig({ ...baseCfg, liveness: { resume_attempts: -1 } }), ConfigError);
});

test("liveness.nonce_enabled must be a boolean", () => {
  assert.throws(() => parseConfig({ ...baseCfg, liveness: { nonce_enabled: "yes" } }), ConfigError);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --experimental-strip-types --test src/config.test.ts`
Expected: FAIL — `c.liveness` undefined.

- [ ] **Step 3: Modify config.ts**

Add the interface and default near the top (after `CatalogConfig`):
```typescript
export interface LivenessConfig {
  nonceEnabled: boolean;
  idleTimeoutSeconds: number;
  resumeAttempts: number;
}
```
Add `liveness: LivenessConfig;` to the `Config` interface. Add the default constant beside `DEFAULT_TTL`:
```typescript
// idleTimeoutSeconds default 330 sits deliberately OUTSIDE pi's 300s HTTP idle window (see Global
// Constraints) so pi's own abort/self-retry fires before Pykrete's watchdog. resumeAttempts default 1;
// note the deadline caveat below (a single candidate's resume loop can consume up to
// (resumeAttempts+1) x OVERALL_TIMEOUT_MS of non-paused wall-time, since the overall deadline is
// enforced BETWEEN candidates, not within one — see Task 8 design note).
const DEFAULT_LIVENESS: LivenessConfig = { nonceEnabled: true, idleTimeoutSeconds: 330, resumeAttempts: 1 };
```
Before the final `return`, parse the block:
```typescript
  // liveness — transport-liveness knobs; all optional with reliability-first defaults.
  const liveness: LivenessConfig = { ...DEFAULT_LIVENESS };
  const livenessRaw = root.liveness;
  if (livenessRaw !== undefined) {
    if (typeof livenessRaw !== "object" || livenessRaw === null) {
      throw new ConfigError("[liveness] must be a table");
    }
    const l = livenessRaw as Record<string, unknown>;
    if (l.nonce_enabled !== undefined) {
      if (typeof l.nonce_enabled !== "boolean") throw new ConfigError("[liveness].nonce_enabled must be a boolean");
      liveness.nonceEnabled = l.nonce_enabled;
    }
    if (l.idle_timeout_seconds !== undefined) {
      const v = l.idle_timeout_seconds;
      if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
        throw new ConfigError("[liveness].idle_timeout_seconds must be a positive integer");
      }
      liveness.idleTimeoutSeconds = v;
    }
    if (l.resume_attempts !== undefined) {
      const v = l.resume_attempts;
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
        throw new ConfigError("[liveness].resume_attempts must be a non-negative integer");
      }
      liveness.resumeAttempts = v;
    }
  }
```
Change the final return to include `liveness`:
```typescript
  return { defaultFamily, catalog: { ttlSeconds }, families, defaults, liveness };
```

- [ ] **Step 4: Surface liveness on cli.ts RunResult**

In `src/cli.ts`, import the type and extend `RunResult`:
```typescript
import { loadConfig, type LivenessConfig } from "./config.ts";
```
Add to the `RunResult` interface:
```typescript
  liveness: LivenessConfig;
```
Change the final `return` in `run(...)` to include it, and warn (do not reject — Q3) when the idle
threshold undercuts pi's 300 s HTTP idle window. Add just before the `return`:
```typescript
  // D1/Q3: idle_timeout_seconds should exceed pi's 300s HTTP idle window (default 330). A lower value
  // may false-kill a slow-but-alive stream; warn but allow it (an operator may have lowered pi's own
  // httpIdleTimeout to match).
  if (config.liveness.idleTimeoutSeconds <= 300) {
    warn(`pykrete: idle_timeout_seconds=${config.liveness.idleTimeoutSeconds} is within pi's 300s HTTP idle window; slow-but-alive streams may be killed early`);
  }
  return { candidates: ordered, intendedLead, task, family, prompt: parsed.prompt, liveness: config.liveness };
```

- [ ] **Step 5: Run to verify pass + typecheck**

Run: `node --experimental-strip-types --test src/config.test.ts src/cli.test.ts && npx tsc --noEmit`
Expected: config + cli tests PASS. (`tsc` may still flag failover from Task 3/4 — deferred to Task 7.)

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/config.test.ts src/cli.ts
git commit -m "feat: [liveness] config block (nonce/idle/resume) surfaced on RunResult"
```

---

### Task 6: runCandidate.ts (per-candidate lifecycle)

**Files:**
- Create: `src/runCandidate.ts`
- Test: `src/runCandidate.test.ts`

**Interfaces:**
- Consumes: `classify`/`Verdict` (classify.ts), `launchAttempt`/`AttemptOutcome` (launch.ts type only), `mintNonce`/`buildSuffix`/`buildResumePrompt`/`noncePresent`/`stripSentinel` (nonce.ts), `Reachability` (reachability.ts).
- Produces:
  - `interface CandidateContext { prompt: string; nonceEnabled: boolean; resumeAttempts: number }`
  - `interface RunCandidateDeps { launch: (req: { prompt: string; continueSession: boolean }) => Promise<AttemptOutcome>; probe: () => Promise<Reachability>; sleep: (ms: number) => Promise<void>; sessionReady: () => boolean; warn: (msg: string) => void }`
  - `type CandidateResult = (| { kind: "success"; text: string } | { kind: "incomplete"; text: string; message: string } | { kind: "failover"; verdict: Verdict } | { kind: "fatal"; message: string } | { kind: "transient"; message: string }) & { pausedMs: number }` — `incomplete.message` is the loud PARTIAL banner reason.
  - `runCandidate(ctx: CandidateContext, deps: RunCandidateDeps): Promise<CandidateResult>`

**Design note (fills a gap in spec §5):** Spec B routed *any* failure after assistant output to exit 1 (post-output death), never failover. Spec §5's `CandidateResult` list omitted this. The dispatch now distinguishes three post-output cases by branch order: (a) **resumable** — clean-stop-incomplete or a post-output idle stall — resumes; (b) **transient/outage** — a post-output transient goes through the reachability gate and *waits out a real outage* (D4), retrying on recovery, rather than exiting immediately; (c) **hard failure** — a post-output model-unavailable/fatal (a clean provider response proving the API is up) maps to `kind: "fatal"` (exit 1, no emit, no failover — Spec B row 9). A post-output **ambiguous** is NOT assumed clean: it is probed first (spike AR-1), and only maps to fatal if the probe confirms the API is up; if the probe is down/throttled it is waited out and the candidate resumed. Branch order in the loop enforces exactly this precedence: success → incomplete-resume → idle → transient-gate → **ambiguous-gate (AR-1)** → post-output-hard-fatal → clean-fatal → failover.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/runCandidate.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCandidate, type RunCandidateDeps } from "./runCandidate.ts";
import type { AttemptOutcome } from "./launch.ts";
import type { PiRunOutcome } from "./pi-events.ts";
import type { Reachability } from "./reachability.ts";

function outcome(o: Partial<PiRunOutcome>, extra: Partial<AttemptOutcome> = {}): AttemptOutcome {
  // terminalText defaults to `text` (the common case where the terminal block carries the final
  // answer). The split-block test overrides terminalText explicitly to exercise finding E.
  const oc: PiRunOutcome = { text: "", terminalText: "", sawAssistantOutput: false, ...o };
  if (o.terminalText === undefined) oc.terminalText = oc.text;
  return {
    outcome: oc,
    startupTimedOut: false, overallTimedOut: false, idledOut: false,
    exitCode: 0, signal: null, stderr: "", ...extra,
  };
}

// Scripts a sequence of launch outcomes (one per launch call) and records the requests.
function scriptedLaunch(seq: AttemptOutcome[], reqs: { prompt: string; continueSession: boolean }[]) {
  let i = 0;
  return (req: { prompt: string; continueSession: boolean }) => {
    reqs.push(req);
    return Promise.resolve(seq[i++] ?? seq[seq.length - 1]);
  };
}

function baseDeps(over: Partial<RunCandidateDeps> = {}): RunCandidateDeps {
  return {
    launch: () => Promise.resolve(outcome({ stopReason: "stop", text: "X", sawAssistantOutput: true })),
    probe: () => Promise.resolve("up" as Reachability),
    sleep: () => Promise.resolve(),
    sessionReady: () => true,
    warn: () => {},
    ...over,
  };
}

const ctx = { prompt: "do it", nonceEnabled: true, resumeAttempts: 1 };

test("nonce present on first try -> success, sentinel stripped, suffix injected", async () => {
  const reqs: { prompt: string; continueSession: boolean }[] = [];
  // We do not know the minted nonce; the launch echoes whatever nonce the suffix carried.
  const launch: RunCandidateDeps["launch"] = (req) => {
    reqs.push(req);
    const m = /WORK COMPLETE ([0-9a-f]{16})/.exec(req.prompt);
    const nonce = m ? m[1] : "";
    return Promise.resolve(outcome({ stopReason: "stop", text: `answer\nWORK COMPLETE ${nonce}`, sawAssistantOutput: true }));
  };
  const r = await runCandidate(ctx, baseDeps({ launch }));
  assert.equal(r.kind, "success");
  assert.equal(r.kind === "success" && r.text, "answer");
  assert.equal(reqs[0].continueSession, false);
  assert.match(reqs[0].prompt, /do it/);
  assert.match(reqs[0].prompt, /WORK COMPLETE [0-9a-f]{16}/);
});

test("nonce missing then present on resume -> success on the 2nd attempt", async () => {
  const reqs: { prompt: string; continueSession: boolean }[] = [];
  let n = 0;
  const launch: RunCandidateDeps["launch"] = (req) => {
    reqs.push(req);
    const nonce = (/WORK COMPLETE ([0-9a-f]{16})/.exec(req.prompt) ?? [])[1] ?? "";
    n += 1;
    return Promise.resolve(
      n === 1
        ? outcome({ stopReason: "stop", text: "partial, not done", sawAssistantOutput: true })
        : outcome({ stopReason: "stop", text: `done\nWORK COMPLETE ${nonce}`, sawAssistantOutput: true }),
    );
  };
  const r = await runCandidate(ctx, baseDeps({ launch }));
  assert.equal(r.kind, "success");
  assert.equal(r.kind === "success" && r.text, "done"); // D11: sentinel stripped on the resume path too
  assert.equal(reqs.length, 2);
  assert.equal(reqs[1].continueSession, true);
});

test("resume budget exhausted -> incomplete with partial text, exit-1 semantics", async () => {
  const launch: RunCandidateDeps["launch"] = () =>
    Promise.resolve(outcome({ stopReason: "stop", text: "still not done", sawAssistantOutput: true }));
  const r = await runCandidate({ ...ctx, resumeAttempts: 1 }, baseDeps({ launch }));
  assert.equal(r.kind, "incomplete");
  assert.equal(r.kind === "incomplete" && r.text, "still not done");
});

test("pre-output idle stall + probe up -> failover (ambiguous)", async () => {
  const launch: RunCandidateDeps["launch"] = () =>
    Promise.resolve(outcome({}, { idledOut: true }));
  const r = await runCandidate(ctx, baseDeps({ launch }));
  assert.equal(r.kind, "failover");
  assert.equal(r.kind === "failover" && r.verdict.kind, "ambiguous");
});

// FIX C: post-output incomplete with no resumable session is a TERMINAL partial (emit + banner + exit 1),
// NOT a failover to the next model (which would run another model over the first's side-effects).
test("session not ready -> incomplete (partial), never failover", async () => {
  const launch: RunCandidateDeps["launch"] = () =>
    Promise.resolve(outcome({ stopReason: "stop", text: "no nonce", sawAssistantOutput: true }));
  const r = await runCandidate(ctx, baseDeps({ launch, sessionReady: () => false }));
  assert.equal(r.kind, "incomplete");
  assert.ok(r.kind === "incomplete" && /no resumable session on disk/.test(r.message)); // routed via resumeOrTerminal (Fix C), not the outage helper
});

// FIX B: outage-recovery after post-output must NOT blindly --continue when no session exists.
test("outage recovery, post-output, no session -> incomplete (not a blind --continue)", async () => {
  let launches = 0;
  let probes = 0;
  const launch: RunCandidateDeps["launch"] = (req) => {
    launches += 1;
    // attempt 1: produced output then idle-killed; there is never a resumable session on disk.
    return Promise.resolve(outcome({ text: "partial work", sawAssistantOutput: true }, { idledOut: true }));
  };
  const probe = () => Promise.resolve<Reachability>(probes++ === 0 ? "down" : "up");
  const r = await runCandidate(ctx, baseDeps({
    launch, probe, sleep: () => Promise.resolve(), sessionReady: () => false,
  }));
  assert.equal(r.kind, "incomplete");   // recovered from outage, but cannot resume -> partial
  assert.ok(r.kind === "incomplete" && /after outage/.test(r.message)); // routed via the outage helper (Fix B), not resumeOrTerminal
  assert.equal(launches, 1);            // did NOT relaunch with --continue into an empty session
});

test("bad key surfaces as inference 401 -> fatal, no probe (AR-2: auth is a classify verdict, not a probe state)", async () => {
  // Spike AR-2: the /models probe is public and cannot see auth; a bad key is detected only when the
  // inference returns 401, which classify maps to fatal (branch 6). A clean 401 proves the API is
  // reachable, so no outage probe fires.
  let probed = false;
  const launch: RunCandidateDeps["launch"] = () =>
    Promise.resolve(outcome({ stopReason: "error", errorMessage: '401: {"type":"invalid_api_key"}', sawAssistantOutput: false }));
  const r = await runCandidate(ctx, baseDeps({
    launch,
    probe: () => { probed = true; return Promise.resolve<Reachability>("up"); },
  }));
  assert.equal(r.kind, "fatal");
  assert.equal(probed, false);
});

test("probe down-then-up during resume: retries same candidate, no failover, pausedMs>0", async () => {
  let probes = 0;
  const probe = () => Promise.resolve<Reachability>(probes++ === 0 ? "down" : "up");
  const slept: number[] = [];
  let n = 0;
  const launch: RunCandidateDeps["launch"] = (req) => {
    const nonce = (/WORK COMPLETE ([0-9a-f]{16})/.exec(req.prompt) ?? [])[1] ?? "";
    n += 1;
    return Promise.resolve(
      n === 1
        ? outcome({ stopReason: "stop", text: "not done", sawAssistantOutput: true })
        : outcome({ stopReason: "stop", text: `WORK COMPLETE ${nonce}`, sawAssistantOutput: true }),
    );
  };
  const r = await runCandidate(ctx, baseDeps({ launch, probe, sleep: (ms) => { slept.push(ms); return Promise.resolve(); } }));
  assert.equal(r.kind, "success");
  assert.equal(r.pausedMs, 1000); // exactly one backoff rung walked (not just > 0)
  assert.deepEqual(slept, [1000]); // recovered after the first 1s rung
});

test("probe down to the cap -> transient (exit 1), ladder is 1,2,4,...,1024s", async () => {
  const slept: number[] = [];
  const launch: RunCandidateDeps["launch"] = () =>
    Promise.resolve(outcome({ stopReason: "stop", text: "not done", sawAssistantOutput: true }));
  const r = await runCandidate(ctx, baseDeps({
    launch,
    probe: () => Promise.resolve("down"),
    sleep: (ms) => { slept.push(ms); return Promise.resolve(); },
  }));
  assert.equal(r.kind, "transient");
  assert.deepEqual(slept, [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 512000, 1024000]);
});

test("nonce disabled: clean stop -> success (no resume, Spec B parity)", async () => {
  const launch: RunCandidateDeps["launch"] = () =>
    Promise.resolve(outcome({ stopReason: "stop", text: "answer", sawAssistantOutput: true }));
  const r = await runCandidate({ ...ctx, nonceEnabled: false }, baseDeps({ launch }));
  assert.equal(r.kind, "success");
  assert.equal(r.kind === "success" && r.text, "answer");
});

test("clean model-unavailable (no output) -> failover, no probe", async () => {
  let probed = false;
  const launch: RunCandidateDeps["launch"] = () =>
    Promise.resolve(outcome({ stopReason: "error", model: "m", errorMessage: "404 not_found_error" }));
  const r = await runCandidate(ctx, baseDeps({ launch, probe: () => { probed = true; return Promise.resolve("up"); } }));
  assert.equal(r.kind, "failover");
  assert.equal(probed, false);
});

test("post-output hard error -> fatal (exit-1, no failover)", async () => {
  const launch: RunCandidateDeps["launch"] = () =>
    Promise.resolve(outcome({ stopReason: "error", model: "m", errorMessage: "400 Model m not supported", sawAssistantOutput: true }));
  const r = await runCandidate(ctx, baseDeps({ launch }));
  assert.equal(r.kind, "fatal");
});

// D8 (anti-cascade headline): an idle stall during an outage must BACK OFF, not fail over.
test("idle stall + probe down-then-up -> backs off and retries the SAME candidate, never failover", async () => {
  let probes = 0;
  const probe = () => Promise.resolve<Reachability>(probes++ === 0 ? "down" : "up");
  const slept: number[] = [];
  let n = 0;
  const launch: RunCandidateDeps["launch"] = (req) => {
    const nonce = (/WORK COMPLETE ([0-9a-f]{16})/.exec(req.prompt) ?? [])[1] ?? "";
    n += 1;
    return Promise.resolve(
      n === 1
        ? outcome({}, { idledOut: true }) // pre-output idle, no terminal
        : outcome({ stopReason: "stop", text: `WORK COMPLETE ${nonce}`, sawAssistantOutput: true }),
    );
  };
  const r = await runCandidate(ctx, baseDeps({ launch, probe, sleep: (ms) => { slept.push(ms); return Promise.resolve(); } }));
  assert.equal(r.kind, "success");   // recovered -> fresh relaunch succeeded; NOT failover
  assert.equal(r.pausedMs, 1000); // exactly one backoff rung walked (not just > 0)
  assert.deepEqual(slept, [1000]);
});

// AR-1: a network outage surfaces as an ambiguous "Connection error." (no HTTP status). It must be
// PROBED and waited out (retry the same candidate), never failed over as if it were a clean ambiguous.
test("ambiguous connection-error + probe down-then-up -> backs off, retries SAME candidate, success", async () => {
  let probes = 0;
  const probe = () => Promise.resolve<Reachability>(probes++ === 0 ? "down" : "up");
  const slept: number[] = [];
  const reqs: { prompt: string; continueSession: boolean }[] = [];
  let n = 0;
  const launch: RunCandidateDeps["launch"] = (req) => {
    reqs.push(req);
    const nonce = (/WORK COMPLETE ([0-9a-f]{16})/.exec(req.prompt) ?? [])[1] ?? "";
    n += 1;
    return Promise.resolve(
      n === 1
        ? outcome({ stopReason: "error", errorMessage: "Connection error.", sawAssistantOutput: false })
        : outcome({ stopReason: "stop", text: `done\nWORK COMPLETE ${nonce}`, sawAssistantOutput: true }),
    );
  };
  const r = await runCandidate(ctx, baseDeps({ launch, probe, sleep: (ms) => { slept.push(ms); return Promise.resolve(); } }));
  assert.equal(r.kind, "success");        // outage waited out + retried, NOT failover
  assert.equal(n, 2);                     // relaunched the SAME candidate after recovery
  assert.equal(reqs[1].continueSession, false); // fresh relaunch (no output was produced), not --continue
  assert.deepEqual(slept, [1000]);        // exactly one backoff rung
});

// AR-1 converse: an ambiguous verdict when the API is genuinely UP (a truncated/inconclusive stream,
// not an outage) still fails over — the probe distinguishes the two.
test("ambiguous + probe up -> failover (genuine ambiguity, not an outage)", async () => {
  let probes = 0;
  const launch: RunCandidateDeps["launch"] = () =>
    Promise.resolve(outcome({ stopReason: "error", errorMessage: "Connection error.", sawAssistantOutput: false }));
  const r = await runCandidate(ctx, baseDeps({ launch, probe: () => { probes += 1; return Promise.resolve<Reachability>("up"); } }));
  assert.equal(r.kind, "failover");
  assert.equal(r.kind === "failover" && r.verdict.kind, "ambiguous");
  assert.equal(probes, 1);                // probed once, API up -> straight to failover
});

// D8: post-output idle stall (row 3) unifies with the nonce-miss resume path.
test("post-output idle stall + probe up -> resume -> success", async () => {
  const reqs: { prompt: string; continueSession: boolean }[] = [];
  let n = 0;
  const launch: RunCandidateDeps["launch"] = (req) => {
    reqs.push(req);
    const nonce = (/WORK COMPLETE ([0-9a-f]{16})/.exec(req.prompt) ?? [])[1] ?? "";
    n += 1;
    return Promise.resolve(
      n === 1
        ? outcome({ text: "THINKING", sawAssistantOutput: true }, { idledOut: true }) // stalled after output, no terminal
        : outcome({ stopReason: "stop", text: `done\nWORK COMPLETE ${nonce}`, sawAssistantOutput: true }),
    );
  };
  const r = await runCandidate(ctx, baseDeps({ launch }));
  assert.equal(r.kind, "success");
  assert.equal(reqs[1].continueSession, true); // resumed the same candidate
});

// D4: a post-output TRANSIENT during a real outage waits it out, then retries — NOT an immediate exit 1.
test("post-output transient + probe down-then-up -> waits out the outage, retries, success", async () => {
  let probes = 0;
  const probe = () => Promise.resolve<Reachability>(probes++ === 0 ? "down" : "up");
  const slept: number[] = [];
  let n = 0;
  const launch: RunCandidateDeps["launch"] = (req) => {
    const nonce = (/WORK COMPLETE ([0-9a-f]{16})/.exec(req.prompt) ?? [])[1] ?? "";
    n += 1;
    return Promise.resolve(
      n === 1
        ? outcome({ stopReason: "error", errorMessage: "503 service_unavailable", text: "partial", sawAssistantOutput: true })
        : outcome({ stopReason: "stop", text: `done\nWORK COMPLETE ${nonce}`, sawAssistantOutput: true }),
    );
  };
  const r = await runCandidate(ctx, baseDeps({ launch, probe, sleep: (ms) => { slept.push(ms); return Promise.resolve(); } }));
  assert.equal(r.kind, "success");
  assert.equal(r.pausedMs, 1000); // exactly one backoff rung walked (not just > 0)
  assert.deepEqual(slept, [1000]);
});

// D6: a 429 (throttled) probe enters the backoff ladder like down, but on recovery retries.
test("throttled (429) probe then up -> backs off then retries", async () => {
  let probes = 0;
  const probe = () => Promise.resolve<Reachability>(probes++ === 0 ? "throttled" : "up");
  const slept: number[] = [];
  let n = 0;
  const launch: RunCandidateDeps["launch"] = (req) => {
    const nonce = (/WORK COMPLETE ([0-9a-f]{16})/.exec(req.prompt) ?? [])[1] ?? "";
    n += 1;
    return n === 1
      ? Promise.resolve(outcome({ stopReason: "stop", text: "not done", sawAssistantOutput: true }))
      : Promise.resolve(outcome({ stopReason: "stop", text: `WORK COMPLETE ${nonce}`, sawAssistantOutput: true }));
  };
  const r = await runCandidate(ctx, baseDeps({ launch, probe, sleep: (ms) => { slept.push(ms); return Promise.resolve(); } }));
  assert.equal(r.kind, "success");
  assert.deepEqual(slept, [1000]);
});

// D2: nonce DISABLED + post-output idle stall must NOT emit a partial (Spec B suppressed it) -> fatal, no emit.
// FIX D + Q1: nonce disabled, post-output stall -> unified partial terminal (emit partial + loud
// banner + exit 1). NOT a fatal no-emit (superseded), NOT a fresh re-run.
test("nonce disabled + post-output idle stall -> incomplete (partial + banner)", async () => {
  const launch: RunCandidateDeps["launch"] = () =>
    Promise.resolve(outcome({ text: "THINKING", sawAssistantOutput: true }, { idledOut: true }));
  const r = await runCandidate({ ...ctx, nonceEnabled: false }, baseDeps({ launch }));
  assert.equal(r.kind, "incomplete");
  assert.equal(r.kind === "incomplete" && r.text, "THINKING"); // partial emitted
});

// FIX E: a nonce present ONLY in a non-terminal block (empty terminal turn) must NOT read as success.
test("nonce in a non-terminal block (empty terminal turn) -> not success, resumes", async () => {
  const reqs: { prompt: string; continueSession: boolean }[] = [];
  let n = 0;
  const launch: RunCandidateDeps["launch"] = (req) => {
    reqs.push(req);
    const nonce = (/WORK COMPLETE ([0-9a-f]{16})/.exec(req.prompt) ?? [])[1] ?? "";
    n += 1;
    // attempt 1: marker only in `text` (non-terminal), terminalText empty -> np must be false -> resume.
    return Promise.resolve(
      n === 1
        ? outcome({ stopReason: "stop", text: `WORK COMPLETE ${nonce}`, terminalText: "", sawAssistantOutput: true })
        : outcome({ stopReason: "stop", text: `done\nWORK COMPLETE ${nonce}`, terminalText: `done\nWORK COMPLETE ${nonce}`, sawAssistantOutput: true }),
    );
  };
  const r = await runCandidate(ctx, baseDeps({ launch }));
  assert.equal(r.kind, "success");
  assert.equal(reqs.length, 2);            // did not accept the non-terminal marker; resumed
  assert.equal(reqs[1].continueSession, true);
});

// LOW-2/3: pin the throttled label, the MAX_OUTAGE_RETRIES bound, and the idle+overall precedence.
test("throttled probe logs 'rate-limited', down logs 'unreachable'", async () => {
  const warns: string[] = [];
  const throttledThenUp = (() => { let i = 0; return () => Promise.resolve<Reachability>(i++ === 0 ? "throttled" : "up"); })();
  // First launch is incomplete (no nonce) to force the gate; the resume then completes.
  let n = 0;
  const launch: RunCandidateDeps["launch"] = (req) => {
    const nonce = (/WORK COMPLETE ([0-9a-f]{16})/.exec(req.prompt) ?? [])[1] ?? "";
    n += 1;
    return Promise.resolve(n === 1
      ? outcome({ stopReason: "stop", text: "no nonce", terminalText: "no nonce", sawAssistantOutput: true })
      : outcome({ stopReason: "stop", text: `WORK COMPLETE ${nonce}`, terminalText: `WORK COMPLETE ${nonce}`, sawAssistantOutput: true }));
  };
  await runCandidate(ctx, baseDeps({ launch, probe: throttledThenUp, sleep: () => Promise.resolve(), warn: (m) => warns.push(m) }));
  assert.ok(warns.some((w) => w.includes("rate-limited")));
  assert.ok(!warns.some((w) => w.includes("unreachable")));
});

test("a flapping network (down/up forever) terminates at MAX_OUTAGE_RETRIES with transient", async () => {
  // Idle every attempt; probe recovers each time -> retrySameCandidateAfterOutage relaunches without
  // spending resume budget. Bounded by MAX_OUTAGE_RETRIES so it cannot loop forever.
  const probe = (() => { let i = 0; return () => Promise.resolve<Reachability>(i++ % 2 === 0 ? "down" : "up"); })();
  const launch: RunCandidateDeps["launch"] = () => Promise.resolve(outcome({}, { idledOut: true })); // pre-output idle, no session
  const r = await runCandidate(ctx, baseDeps({ launch, probe, sleep: () => Promise.resolve() }));
  assert.equal(r.kind, "transient"); // gave up after MAX_OUTAGE_RETRIES
});

test("idledOut AND overallTimedOut both set -> idle route (reachability gate) wins (D5)", async () => {
  let probed = false;
  const launch: RunCandidateDeps["launch"] = () =>
    Promise.resolve(outcome({}, { idledOut: true, overallTimedOut: true }));
  const r = await runCandidate(ctx, baseDeps({
    launch,
    probe: () => { probed = true; return Promise.resolve("up"); },
  }));
  assert.equal(probed, true);          // went through the reachability gate (idle route), not classify's transient
  assert.equal(r.kind, "failover");    // pre-output idle + probe up -> ambiguous failover
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --experimental-strip-types --test src/runCandidate.test.ts`
Expected: FAIL — `Cannot find module './runCandidate.ts'`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/runCandidate.ts
import { classify, type Verdict } from "./classify.ts";
import type { AttemptOutcome } from "./launch.ts";
import { mintNonce, buildSuffix, buildResumePrompt, noncePresent, stripSentinel } from "./nonce.ts";
import type { Reachability } from "./reachability.ts";

export interface CandidateContext {
  prompt: string;
  nonceEnabled: boolean;
  resumeAttempts: number;
}

export interface RunCandidateDeps {
  launch: (req: { prompt: string; continueSession: boolean }) => Promise<AttemptOutcome>;
  probe: () => Promise<Reachability>;
  sleep: (ms: number) => Promise<void>;
  sessionReady: () => boolean;
  warn: (msg: string) => void;
}

export type CandidateResult = (
  | { kind: "success"; text: string }
  | { kind: "incomplete"; text: string; message: string } // message = the loud PARTIAL banner reason
  | { kind: "failover"; verdict: Verdict }
  | { kind: "fatal"; message: string }
  | { kind: "transient"; message: string }
) & { pausedMs: number };

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_FACTOR = 2;
const BACKOFF_CAP_MS = 1_024_000; // 2^10 s
const MAX_OUTAGE_RETRIES = 10; // backstop against a flapping network (recover->relaunch->re-outage forever)

// One gate handles ALL outage/throttle waiting. `proceed` = API was up on the first probe (no outage,
// route per verdict). `recovered` = it was down/throttled, we backed off, it came back (retry the same
// candidate — the outage is over). `giveup` = ladder exhausted. Every slept ms is added to `pausedMs`
// so an outage pauses (never burns) the overall deadline. There is no `fatal`/auth result: the probe
// hits the PUBLIC /models endpoint (spike AR-2), so it can never observe a bad key — auth is caught
// upstream by classify (inference 401 -> fatal), which returns before any gate is reached.
type GateResult =
  | { kind: "proceed" }
  | { kind: "recovered" }
  | { kind: "giveup"; message: string };

export async function runCandidate(ctx: CandidateContext, deps: RunCandidateDeps): Promise<CandidateResult> {
  let pausedMs = 0;

  const gate = async (): Promise<GateResult> => {
    const first = await deps.probe();
    if (first === "up") return { kind: "proceed" };
    // down | throttled -> exponential backoff-wait (D6: a 429 is reachable but still warrants backoff)
    const label = first === "throttled" ? "rate-limited" : "unreachable";
    let delay = BACKOFF_BASE_MS;
    while (delay <= BACKOFF_CAP_MS) {
      deps.warn(`pykrete: NanoGPT ${label}; waiting ${Math.round(delay / 1000)}s before re-probe`);
      await deps.sleep(delay);
      pausedMs += delay;
      const p = await deps.probe();
      if (p === "up") return { kind: "recovered" };
      delay *= BACKOFF_FACTOR;
    }
    return { kind: "giveup", message: `NanoGPT ${label}; gave up after backoff` };
  };

  const nonce = ctx.nonceEnabled ? mintNonce() : undefined;
  const freshLaunch = () => deps.launch({ prompt: nonce ? ctx.prompt + buildSuffix(nonce) : ctx.prompt, continueSession: false });
  // resumeLaunch is only ever called with nonce defined (every callsite guards nonce !== undefined
  // first); the `as string` is safe under those guards.
  const resumeLaunch = () => deps.launch({ prompt: buildResumePrompt(nonce as string), continueSession: true });

  let outcome = await freshLaunch();
  let attemptsLeft = ctx.resumeAttempts;
  let outageRetries = 0;

  for (;;) {
    // FIX A: classify takes a PiRunOutcome, i.e. outcome.outcome — NOT the AttemptOutcome wrapper.
    // FIX E/D3: the nonce counts only in the TERMINAL assistant block. The accumulator exposes
    // `terminalText` (text of the terminal message_end/turn_end, possibly empty) separately from
    // `text` (last non-empty turn, used for emission), so a marker in a non-terminal block pi never
    // terminated does NOT read as success.
    const np = nonce ? noncePresent(outcome.outcome.terminalText, nonce) : undefined;
    const verdict = classify(
      outcome.outcome,
      { startupTimedOut: outcome.startupTimedOut, overallTimedOut: outcome.overallTimedOut },
      np,
    );
    const sawOutput = outcome.outcome.sawAssistantOutput;
    const stripped = () => (nonce ? stripSentinel(outcome.outcome.text, nonce) : outcome.outcome.text);

    // Unified terminal for "produced output but cannot cleanly complete/resume" (B/C/D + old D2):
    // emit the partial to stdout AND (in failover.ts) print a loud PARTIAL banner to stderr, exit 1.
    // Never failover (output already produced), never a fresh re-run (would duplicate side-effects).
    // `message` is the banner's reason. The loud banner is what makes emitting the partial safe.
    const partial = (reason: string): CandidateResult => ({ kind: "incomplete", text: stripped(), message: reason, pausedMs });

    // 1. Clean success.
    if (verdict.kind === "success") return { kind: "success", text: stripped(), pausedMs };

    // On outage recovery, retry the same candidate WITHOUT spending resume budget. If output was
    // already produced we MUST resume to preserve it; if we cannot (nonce disabled, or pi wrote no
    // resumable session), that is the unified partial terminal (FIX B/D) — never a blind fresh re-run.
    const retrySameCandidateAfterOutage = async (): Promise<CandidateResult | "looped"> => {
      if (++outageRetries > MAX_OUTAGE_RETRIES) {
        return { kind: "transient", message: "NanoGPT connectivity too unstable; gave up", pausedMs };
      }
      if (!sawOutput) {
        outcome = await freshLaunch(); // nothing produced yet -> a fresh retry after the outage is correct
        return "looped";
      }
      if (nonce === undefined || !deps.sessionReady()) {
        return partial("output produced but cannot resume after outage (no resumable session)");
      }
      outcome = await resumeLaunch();
      return "looped";
    };

    // Resume an "output present but incomplete" run, or return its terminal. Cannot-resume cases all
    // route to the unified partial terminal (never failover after output; never a silent no-emit).
    // The relaunch is gated (a network drop between attempts re-triggers the outage wait — D4).
    const resumeOrTerminal = async (): Promise<CandidateResult | "looped"> => {
      if (nonce === undefined) return partial("nonce disabled; cannot verify completion or resume"); // FIX D
      if (attemptsLeft <= 0) return partial("resume budget exhausted; task may be incomplete");
      if (!deps.sessionReady()) return partial("no resumable session on disk; cannot continue"); // FIX C (was failover)
      const g = await gate();
      if (g.kind === "giveup") return { kind: "transient", message: g.message, pausedMs };
      // proceed | recovered -> relaunch as a resume. NOTE (spec §5 clarified): a resume that had to
      // wait out an outage DOES consume a resume attempt (unlike retrySameCandidateAfterOutage above).
      attemptsLeft -= 1;
      outcome = await resumeLaunch();
      return "looped";
    };

    // 2. Clean stop, nonce missing, output present -> resume (no entry probe: a clean stop proves the
    //    API was up at completion).
    if (verdict.kind === "incomplete") {
      const r = await resumeOrTerminal();
      if (r === "looped") continue;
      return r;
    }

    // 3. Idle stall -> reachability-probe FIRST (an outage preempts the stall interpretation). Note the
    //    precedence (D5): runCandidate routes on idledOut BEFORE classify's overall-timeout verdict, so
    //    if both flags are set the idle route wins (idle fires first at 330s << the 30min overall bound).
    if (outcome.idledOut) {
      const g = await gate();
      if (g.kind === "giveup") return { kind: "transient", message: g.message, pausedMs };
      if (g.kind === "recovered") {
        const r = await retrySameCandidateAfterOutage();
        if (r === "looped") continue;
        return r;
      }
      // proceed: API up, a genuine stall (not an outage).
      if (sawOutput) {
        const r = await resumeOrTerminal();
        if (r === "looped") continue;
        return r;
      }
      return { kind: "failover", verdict: { kind: "ambiguous", message: "idle stall before any output" }, pausedMs };
    }

    // 4. Transient (429/5xx/aborted from inference) -> gate. Per D4 a real outage is waited out; a
    //    genuine transient with the API confirmed up exits 1 (pi already retried internally). This
    //    branch is BEFORE the post-output guard so a post-output transient during an outage still waits.
    if (verdict.kind === "transient") {
      const g = await gate();
      if (g.kind === "giveup") return { kind: "transient", message: g.message, pausedMs };
      if (g.kind === "recovered") {
        const r = await retrySameCandidateAfterOutage();
        if (r === "looped") continue;
        return r;
      }
      // proceed: API up, genuine transient. Preserve the "produced output" hint (MEDIUM-3).
      return { kind: "transient", message: `${verdict.message}${sawOutput ? " (after producing output)" : ""}`, pausedMs };
    }

    // 4b. Ambiguous verdict -> might be a NETWORK OUTAGE in disguise (spike AR-1): a connection error
    //     surfaces as errorMessage "Connection error." with NO leading HTTP status, so classify cannot
    //     distinguish it from a genuinely-inconclusive stream (truncated output, startup stall). Probe
    //     before treating it as a clean failure — this sits ahead of BOTH the post-output hard-fatal
    //     and the no-output failover, so an outage is waited out in either output state.
    //     model-unavailable/fatal keep their no-probe fast paths (a real provider response already
    //     proves reachability).
    if (verdict.kind === "ambiguous") {
      const g = await gate();
      if (g.kind === "giveup") return { kind: "transient", message: g.message, pausedMs };
      if (g.kind === "recovered") {
        const r = await retrySameCandidateAfterOutage(); // resumes if output exists, else fresh relaunch
        if (r === "looped") continue;
        return r;
      }
      // proceed: API up -> a genuine ambiguous, not an outage. Fall through to the handling below.
    }

    // 5. Post-output HARD failure (model-unavailable / fatal / probe-confirmed-up ambiguous — a clean
    //    signal that proves the API is up). Spec B row 9: exit 1, no failover, no emit. (A clean
    //    provider rejection after output is distinct from the resumable/incomplete family above.)
    if (sawOutput) return { kind: "fatal", message: `failed after producing output: ${describe(verdict)}`, pausedMs };

    // 6. Clean fatal (no output) -> exit 1.
    if (verdict.kind === "fatal") return { kind: "fatal", message: verdict.message, pausedMs };

    // 7. model-unavailable | ambiguous(probe=up), no output -> failover. model-unavailable takes the
    //    no-probe fast path; an ambiguous verdict has already been probed above (AR-1) and the API was
    //    up, so failing over to the next candidate is correct.
    return { kind: "failover", verdict, pausedMs };
  }
}

function describe(v: Verdict): string {
  return "message" in v ? v.message : v.kind;
}
```

- [ ] **Step 4: Run to verify pass + typecheck**

Run: `node --experimental-strip-types --test src/runCandidate.test.ts && npx tsc --noEmit`
Expected: runCandidate tests PASS. (`tsc` may still flag failover — fixed next task.)

- [ ] **Step 5: Commit**

```bash
git add src/runCandidate.ts src/runCandidate.test.ts
git commit -m "feat: runCandidate per-candidate lifecycle (nonce/resume/idle/backoff)"
```

---

### Task 7: failover.ts (call runCandidate, pause the deadline)

**Files:**
- Modify: `src/failover.ts`
- Test: `src/failover.test.ts` (rewrite deps to inject `runCandidate`)

**Interfaces:**
- Consumes: `CandidateResult` (runCandidate.ts).
- Produces:
  - `FailoverDeps.runCandidate: (candidate: string) => Promise<CandidateResult>` (replaces `launchAttempt` + `overallTimeoutMs`).
  - `FailoverResult` unchanged (`{ exitCode: number; launchedId?: string }`).

- [ ] **Step 1: Rewrite the failover tests**

```typescript
// src/failover.test.ts — REPLACE the file body
import { test } from "node:test";
import assert from "node:assert/strict";
import { runFailover, type FailoverDeps } from "./failover.ts";
import type { CandidateResult } from "./runCandidate.ts";

function deps(scripted: Record<string, CandidateResult>, sink: { out: string[]; warn: string[] }): FailoverDeps {
  return {
    runCandidate: (candidate) => Promise.resolve(scripted[candidate]),
    now: () => 0,
    warn: (m) => sink.warn.push(m),
    emit: (t) => sink.out.push(t),
  };
}

test("lead success -> exit 0, result emitted", async () => {
  const sink = { out: [] as string[], warn: [] as string[] };
  const r = await runFailover(
    { candidates: ["lead", "b"], intendedLead: "lead", prompt: "p" },
    deps({ lead: { kind: "success", text: "ANS", pausedMs: 0 } }, sink),
  );
  assert.equal(r.exitCode, 0);
  assert.deepEqual(sink.out, ["ANS"]);
});

test("resumed success on a substituted candidate is transparent -> exit 3", async () => {
  const sink = { out: [] as string[], warn: [] as string[] };
  const r = await runFailover(
    { candidates: ["lead", "b"], intendedLead: "lead", prompt: "p" },
    deps(
      {
        lead: { kind: "failover", verdict: { kind: "model-unavailable" }, pausedMs: 0 },
        b: { kind: "success", text: "ANS", pausedMs: 0 },
      },
      sink,
    ),
  );
  assert.equal(r.exitCode, 3);
  assert.equal(r.launchedId, "b");
});

test("incomplete -> exit 1, partial emitted, no next candidate tried", async () => {
  const sink = { out: [] as string[], warn: [] as string[] };
  let bTried = false;
  const d: FailoverDeps = {
    runCandidate: (c) => {
      if (c === "b") bTried = true;
      return Promise.resolve<CandidateResult>(
        c === "a" ? { kind: "incomplete", text: "PARTIAL", message: "resume budget exhausted", pausedMs: 0 } : { kind: "success", text: "X", pausedMs: 0 },
      );
    },
    now: () => 0, warn: (m) => sink.warn.push(m), emit: (t) => sink.out.push(t),
  };
  const r = await runFailover({ candidates: ["a", "b"], intendedLead: "a", prompt: "p" }, d);
  assert.equal(r.exitCode, 1);
  assert.deepEqual(sink.out, ["PARTIAL"]);           // partial on STDOUT
  assert.ok(sink.warn.some((w) => /WARNING: PARTIAL OUTPUT/.test(w))); // loud banner on STDERR
  assert.ok(sink.warn.some((w) => w.includes("resume budget exhausted"))); // with the reason
  assert.equal(bTried, false);
});

test("all model-unavailable -> exit 4", async () => {
  const sink = { out: [] as string[], warn: [] as string[] };
  const r = await runFailover(
    { candidates: ["a", "b"], intendedLead: "a", prompt: "p" },
    deps(
      {
        a: { kind: "failover", verdict: { kind: "model-unavailable" }, pausedMs: 0 },
        b: { kind: "failover", verdict: { kind: "model-unavailable" }, pausedMs: 0 },
      },
      sink,
    ),
  );
  assert.equal(r.exitCode, 4);
});

test("an ambiguous stall in the mix -> exit 1, never 4", async () => {
  const sink = { out: [] as string[], warn: [] as string[] };
  const r = await runFailover(
    { candidates: ["a", "b"], intendedLead: "a", prompt: "p" },
    deps(
      {
        a: { kind: "failover", verdict: { kind: "ambiguous", message: "stall" }, pausedMs: 0 },
        b: { kind: "failover", verdict: { kind: "model-unavailable" }, pausedMs: 0 },
      },
      sink,
    ),
  );
  assert.equal(r.exitCode, 1);
});

test("fatal -> exit 1, no further attempts, nothing emitted", async () => {
  const sink = { out: [] as string[], warn: [] as string[] };
  let bTried = false;
  const d: FailoverDeps = {
    runCandidate: (c) => {
      if (c === "b") bTried = true;
      return Promise.resolve<CandidateResult>(
        c === "a" ? { kind: "fatal", message: "bad API key", pausedMs: 0 } : { kind: "success", text: "X", pausedMs: 0 },
      );
    },
    now: () => 0, warn: (m) => sink.warn.push(m), emit: (t) => sink.out.push(t),
  };
  const r = await runFailover({ candidates: ["a", "b"], intendedLead: "a", prompt: "p" }, d);
  assert.equal(r.exitCode, 1);
  assert.equal(bTried, false);
  assert.deepEqual(sink.out, []);
});

test("transient -> exit 1, stops", async () => {
  const sink = { out: [] as string[], warn: [] as string[] };
  const r = await runFailover(
    { candidates: ["a", "b"], intendedLead: "a", prompt: "p" },
    deps({ a: { kind: "transient", message: "gave up after backoff", pausedMs: 0 } }, sink),
  );
  assert.equal(r.exitCode, 1);
});

test("pausedMs is excluded from the deadline: an outage-waiting candidate still gets its budget", async () => {
  const sink = { out: [] as string[], warn: [] as string[] };
  let clock = 0;
  const d: FailoverDeps = {
    // Candidate "a" waited out a 10_000ms outage (pausedMs) and failed over; without the pause
    // exclusion the deadline (deadlineMs 5_000) would trip before "lead" is tried.
    runCandidate: (c) => {
      clock += 10_000;
      return Promise.resolve<CandidateResult>(
        c === "a"
          ? { kind: "failover", verdict: { kind: "model-unavailable" }, pausedMs: 10_000 }
          : { kind: "success", text: "ANS", pausedMs: 0 },
      );
    },
    now: () => clock,
    warn: (m) => sink.warn.push(m),
    emit: (t) => sink.out.push(t),
    deadlineMs: 5_000,
  };
  const r = await runFailover({ candidates: ["a", "lead"], intendedLead: "lead", prompt: "p" }, d);
  assert.equal(r.exitCode, 0);
  assert.equal(r.launchedId, "lead");
});

test("deadline exceeded before an attempt (no pause) -> exit 1", async () => {
  const sink = { out: [] as string[], warn: [] as string[] };
  let clock = 0;
  const d: FailoverDeps = {
    runCandidate: () => {
      clock += 1000;
      return Promise.resolve<CandidateResult>({ kind: "failover", verdict: { kind: "model-unavailable" }, pausedMs: 0 });
    },
    now: () => clock, warn: (m) => sink.warn.push(m), emit: (t) => sink.out.push(t), deadlineMs: 500,
  };
  const r = await runFailover({ candidates: ["a", "b"], intendedLead: "a", prompt: "p" }, d);
  assert.equal(r.exitCode, 1);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --experimental-strip-types --test src/failover.test.ts`
Expected: FAIL — `runCandidate` not on `FailoverDeps`; old `launchAttempt` path.

- [ ] **Step 3: Rewrite failover.ts**

```typescript
// src/failover.ts
import type { Verdict } from "./classify.ts";
import type { CandidateResult } from "./runCandidate.ts";

export interface FailoverPlan {
  candidates: string[];
  intendedLead: string;
  prompt: string;
}

export interface FailoverDeps {
  runCandidate: (candidate: string) => Promise<CandidateResult>;
  now: () => number;
  warn: (msg: string) => void;
  emit: (text: string) => void;
  deadlineMs?: number;
}

export interface FailoverResult {
  exitCode: number;
  launchedId?: string;
}

const DEFAULT_DEADLINE_MS = 3_600_000;

function describe(v: Verdict): string {
  return "message" in v ? v.message : v.kind;
}

export async function runFailover(plan: FailoverPlan, deps: FailoverDeps): Promise<FailoverResult> {
  const deadlineMs = deps.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const start = deps.now();
  let totalPausedMs = 0; // reachability-backoff time; excluded from the deadline so outages never burn it
  let allCleanModelUnavailable = true;

  for (const candidate of plan.candidates) {
    const elapsed = deps.now() - start - totalPausedMs;
    if (deadlineMs - elapsed <= 0) {
      deps.warn(`pykrete: deadline exceeded before trying "${candidate}"`);
      return { exitCode: 1 };
    }

    const result = await deps.runCandidate(candidate);
    totalPausedMs += result.pausedMs;

    if (result.kind === "success") {
      deps.emit(result.text);
      const downgraded = candidate !== plan.intendedLead;
      if (downgraded) deps.warn(`pykrete: substituted "${candidate}" for intended lead "${plan.intendedLead}"`);
      return { exitCode: downgraded ? 3 : 0, launchedId: candidate };
    }

    if (result.kind === "incomplete") {
      // Loud PARTIAL banner to STDERR (not stdout — stdout stays the machine-readable channel); the
      // partial itself goes to stdout; exit 1 is the authoritative "do not trust" signal. The banner
      // makes the partial-ness impossible for a human to miss (review decision Q1).
      const bar = "=".repeat(92);
      deps.warn(`${bar}\n= WARNING: PARTIAL OUTPUT (${result.message}) — TREAT AS INCOMPLETE / REQUIRES VERIFICATION\n${bar}`);
      deps.emit(result.text);
      return { exitCode: 1, launchedId: candidate };
    }

    if (result.kind === "fatal") {
      deps.warn(`pykrete: fatal on "${candidate}" (no failover): ${result.message}`);
      return { exitCode: 1, launchedId: candidate };
    }

    if (result.kind === "transient") {
      deps.warn(`pykrete: transient on "${candidate}" (no failover): ${result.message}`);
      return { exitCode: 1, launchedId: candidate };
    }

    // failover: advance to the next candidate. An ambiguous verdict in the mix forbids exit 4.
    const v = result.verdict;
    if (v.kind === "ambiguous") {
      allCleanModelUnavailable = false;
      deps.warn(`pykrete: "${candidate}" unclassified, failing over: ${describe(v)}`);
    } else {
      deps.warn(`pykrete: "${candidate}" unavailable, failing over`);
    }
  }

  if (allCleanModelUnavailable) {
    deps.warn("pykrete: all candidates unavailable; family appears unavailable");
    return { exitCode: 4 };
  }
  deps.warn("pykrete: all candidates failed (some unclassifiable)");
  return { exitCode: 1 };
}
```

- [ ] **Step 4: Run to verify pass + full typecheck**

Run: `node --experimental-strip-types --test src/failover.test.ts && npx tsc --noEmit`
Expected: failover tests PASS and `tsc --noEmit` is now CLEAN across the repo (the Task 3/4/6 deferrals resolve here).

- [ ] **Step 5: Commit**

```bash
git add src/failover.ts src/failover.test.ts
git commit -m "feat: failover drives runCandidate, maps CandidateResult, pauses deadline on outage"
```

---

### Task 8: bin/pykrete.ts (session-dir lifecycle + real deps wiring)

**Files:**
- Modify: `bin/pykrete.ts`
- Test: `src/bin.test.ts` (add regression cases)

**Interfaces:**
- Consumes: `runFailover` (failover.ts), `runCandidate` (runCandidate.ts), `launchAttempt` (launch.ts), `probeNanoGpt` (reachability.ts), `resolved.liveness` (cli.ts RunResult).
- Produces: nothing (top-level bin).

**Design note (session dirs):** the spec's "per-run session-dir" is realised as **one temp root per run, one subdir per candidate**. A candidate's resumes share its subdir (so `--continue` sees prior context); different candidates get different subdirs (so a failover starts a model with fresh context, not the previous model's history). The whole root is removed in `finally`.

- [ ] **Step 1: Write the failing/regression tests**

```typescript
// src/bin.test.ts — ADD these (keep existing cases; they still exercise the happy paths)
test("liveness happy path: a nonce-emitting model exits 0 and strips the marker from stdout", () => {
  // fake-pi 'nonceok' echoes the prompt's nonce in its final block only when NOT resuming.
  const r = runBin(writeConfig(["nonceok"]), "do it");
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
```

Add the `nonceok` scenario to `fake-pi.mjs` (before the final `else`) — it echoes the prompt's nonce so the real nonce gate passes end-to-end without a network resume:
```javascript
} else if (model.includes("nonceok")) {
  const prompt = argv[argv.length - 1] ?? "";
  const nonce = (/WORK COMPLETE ([0-9a-f]{16})/.exec(prompt) ?? [])[1] ?? "";
  emit({ type: "agent_start" });
  assistant({ content: [{ type: "text", text: `RESULT-OK\nWORK COMPLETE ${nonce}` }], stopReason: "stop" });
  emit({ type: "agent_end" });
```

**Offline-test note:** these bin tests set `NANOGPT_API_KEY=""` and never reach the resume/backoff path (the nonce is satisfied on the first attempt), so `probeNanoGpt` is never called — no network. End-to-end *resume* (which does probe) is validated by the Task 0 live spike and unit-tested in `runCandidate.test.ts`; it is deliberately not exercised in the offline bin suite.

- [ ] **Step 2: Run to verify they fail**

Run: `node --experimental-strip-types --test src/bin.test.ts`
Expected: FAIL — `nonceok`/liveness wiring not present; stdout still contains `WORK COMPLETE`.

- [ ] **Step 3: Rewrite bin/pykrete.ts main() wiring**

Replace the imports block and `main()` body. New imports:
```typescript
#!/usr/bin/env node
import { mkdtempSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.ts";
import { ConfigError } from "../src/config.ts";
import { FamilyError } from "../src/args.ts";
import { buildModelsJson, buildSettingsJson, createAgentDir } from "../src/agentdir.ts";
import { launchAttempt, type HeartbeatInfo } from "../src/launch.ts";
import { runFailover } from "../src/failover.ts";
import { runCandidate } from "../src/runCandidate.ts";
import { probeNanoGpt } from "../src/reachability.ts";
```
(Keep `STARTUP_TIMEOUT_MS`, `OVERALL_TIMEOUT_MS`, `heartbeatMsFromEnv`, `emitHeartbeat` as-is.)

Replace the `agent`/`runFailover` section of `main()` (the `try { ... } finally { agent.cleanup(); }` block) with:
```typescript
  const apiKey = process.env.NANOGPT_API_KEY;
  const heartbeatMs = heartbeatMsFromEnv();
  const liveness = resolved.liveness;
  const agent = createAgentDir(buildModelsJson(resolved.candidates), buildSettingsJson());
  const sessionRoot = mkdtempSync(join(tmpdir(), "pykrete-sess-"));
  try {
    const result = await runFailover(
      { candidates: resolved.candidates, intendedLead: resolved.intendedLead, prompt },
      {
        runCandidate: (candidate) => {
          const sessionDir = join(sessionRoot, encodeURIComponent(candidate));
          mkdirSync(sessionDir, { recursive: true });
          return runCandidate(
            { prompt, nonceEnabled: liveness.nonceEnabled, resumeAttempts: liveness.resumeAttempts },
            {
              launch: (req) =>
                launchAttempt({
                  candidate,
                  prompt: req.prompt,
                  agentDir: agent.dir,
                  apiKey,
                  startupTimeoutMs: STARTUP_TIMEOUT_MS,
                  overallTimeoutMs: OVERALL_TIMEOUT_MS,
                  idleTimeoutMs: liveness.idleTimeoutSeconds * 1000,
                  sessionDir,
                  continueSession: req.continueSession,
                  heartbeatMs,
                  heartbeat: heartbeatMs ? emitHeartbeat : undefined,
                }),
              probe: () => probeNanoGpt({ fetchImpl: fetch, apiKey }),
              sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
              // Resumable state = pi wrote a session transcript (a .jsonl), not merely that Pykrete's
              // own mkdirSync left the dir non-empty (D7). pi's --continue also filters candidate
              // sessions by EXACT resolved-cwd equality, so the resume MUST run from the same cwd as the
              // first attempt — bin spawns pi from a single stable cwd, satisfying this; do not change
              // cwd between a candidate's attempts (Task 0 Step 2 asserts context actually survives).
              sessionReady: () => {
                try {
                  return readdirSync(sessionDir).some((f) => f.endsWith(".jsonl"));
                } catch {
                  return false;
                }
              },
              warn: (m) => console.error(m),
            },
          );
        },
        now: Date.now,
        warn: (m) => console.error(m),
        emit: (text) => process.stdout.write(text.endsWith("\n") ? text : `${text}\n`),
      },
    );
    return result.exitCode;
  } finally {
    agent.cleanup();
    try {
      rmSync(sessionRoot, { recursive: true, force: true });
    } catch {
      // best-effort; a leaked temp dir is harmless
    }
  }
```

- [ ] **Step 4: Run to verify pass + full typecheck + whole suite**

Run: `node --experimental-strip-types --test src/bin.test.ts && npx tsc --noEmit && npm test`
Expected: bin tests PASS; `tsc` clean; the full suite green.

- [ ] **Step 5: Commit**

```bash
git add bin/pykrete.ts src/bin.test.ts src/test-fixtures/fake-pi.mjs
git commit -m "feat: wire liveness/resume into bin with per-run session-dir lifecycle"
```

---

## Self-Review (completed during authoring)

**Spec coverage:**
- §1 nonce.ts → Task 1 ✓ (mint/suffix/resume/present/strip, trim-tolerant match, H2 fence).
- §2 reachability.ts → Task 2 ✓ (up/down/throttled — no auth, spike AR-2; 4s timeout, MODELS_URL reuse).
- §3 launch.ts idle watchdog + sessions → Task 4 ✓ (idledOut, armed-after-first-event via reschedule-on-line, --session-dir/--continue, drop --no-session).
- §4 classify incomplete → Task 3 ✓ (optional noncePresent, incomplete verdict, Task 0 error-shape reconciliation folded in).
- §5 runCandidate → Task 6 ✓ (all routing rows, backoff ladder, pausedMs, sessionReady guard). Post-output-death gap in spec §5 filled and flagged.
- §6 failover → Task 7 ✓ (runCandidate call, CandidateResult map, deadline pause).
- §7 resume prompt → Task 1 `buildResumePrompt` ✓ (status-only, no worktree state).
- Configuration → Task 5 ✓ ([liveness] block + cli surface).
- Exit codes → unchanged; asserted in Tasks 6/7/8.
- §11 testing → each task is TDD; fake-pi `idlepost`/`dumpargs`/`nonceok` added. Resume-end-to-end deliberately unit-tested (not networked in bin) — documented in Task 8.
- Task 0 spike → Task 0 ✓ (all six checks incl. required classify reconciliation).

**Type consistency:** `CandidateResult` shape identical across Task 6 (definition), Task 7 (consumer), Task 8 (wiring). `AttemptOutcome.idledOut` added in Task 4 and consumed in Task 6. `LivenessConfig` field names (`nonceEnabled`/`idleTimeoutSeconds`/`resumeAttempts`) consistent Task 5 → Task 8. `classify(outcome, flags, noncePresent?)` arity consistent Task 3 → Task 6.

**Placeholder scan:** none — every code step carries complete code; every test step carries real assertions.

**Deviations from spec, with rationale (flagged for the reviewer):**
1. Post-output hard failure maps to `CandidateResult.fatal` (spec §5's list omitted it). Preserves Spec B row 9 (exit 1, no failover, no emit). A post-output *transient* is NOT hard — it waits out an outage (D4).
2. Session dirs are per-candidate subdirs under a per-run root (spec said "per-run"). Prevents cross-model context contamination on failover while preserving `--continue` context within a candidate.
3. The overall per-launch timeout stays a bin constant rather than being threaded through `runCandidate` as remaining-deadline; the deadline is enforced between candidates (as in Spec B). A single candidate can therefore run up to **`(resumeAttempts + 1 + MAX_OUTAGE_RETRIES) × OVERALL_TIMEOUT_MS`** of non-paused wall-clock — with defaults `(1 + 1 + 10) × 30 min ≈ 6 h` — plus paused backoff, because outage-recovery relaunches also do not consume `attemptsLeft` and `failover.ts`'s deadline pause only accounts for `sleep()` time, not the relaunches themselves (review finding H). Bounded and accepted for v1; if 6 h is too loose, lower `MAX_OUTAGE_RETRIES` or thread the remaining deadline into `runCandidate`.

**Red-team revisions (2026-07-10, applied after a 5-lens adversarial review; decisions confirmed with the owner):**
- **D1 (Critical, verified in pi source):** idle default raised 120s → **330s** to sit outside pi's 300s HTTP idle window, so pi self-heals first. §3 rationale corrected (the threat is the http-idle window, not the visible retry backoff).
- **D2 (Critical):** nonce-disabled post-output stall no longer silently emits a truncated partial. *(Superseded by the second review pass B/C/D+Q1 decision below: it now emits the partial WITH a loud stderr banner + exit 1, rather than a silent no-emit.)*
- **D3 (owner decision):** nonce counts only on a clean terminal stop; spike Step 4b confirms the accumulator's final-block semantics.
- **D4 (owner decision):** post-output transient routes through the reachability gate and **waits out a real outage** (backoff, paused deadline), retrying on recovery.
- **D5:** `idledOut` vs `overallTimedOut` precedence made explicit (idle route wins) + documented.
- **D6 (owner decision):** 429 → new `throttled` reachability state; reachable (never exit 4) but still enters the exponential backoff.
- **D7:** `sessionReady` hardened to require a `.jsonl` session file; cwd invariant documented.
- **D8:** added the anti-cascade tests (idle+probe=down→backoff-not-failover, post-output idle→resume, post-output transient→wait, throttled→backoff).
- **AR-1 (spike):** ambiguous connection-error+probe=down→backoff+retry-same-candidate (not failover); ambiguous+probe=up→failover. **AR-2 (spike):** probe enum trimmed to `up/down/throttled`; bad-key via inference-401→fatal (no probe).
- **D9/D10/D11/D12:** deadline-overrun documented at the config surface; colon-form 0.80.3 error-shape tests added; resume-path strip assertion added; the double-gate collapsed into one `proceed|recovered|giveup` gate (no `fatal`: auth is not a probe state, spike AR-2).
- **New footgun found + fixed:** a flapping network could loop a single candidate forever (recover→relaunch→re-outage without spending resume budget) — bounded by `MAX_OUTAGE_RETRIES = 10`.
- **D13/D14:** "deliverable"→"output" in `buildSuffix`; scope-guard interpretation to be pinned in the spec (Pykrete inspects a content-free token, never computes a verdict).
- **No scope-guard breach, no loop-termination/arithmetic bug, and the offline-test claim were all confirmed clean by the review.**

**Second review pass (2026-07-10, cross-model multi-review — claude/codex/opencode; owner decisions confirmed):**
- **A (codex, was BLOCKER):** `classify(outcome, …)` → `classify(outcome.outcome, …)` — was passing the `AttemptOutcome` wrapper where a `PiRunOutcome` is expected.
- **B/C/D + Q1 (owner decision):** unified all "produced output but cannot cleanly complete/resume" cases (outage-recovery with no session; clean-incomplete with no session; nonce-disabled post-output stall) into ONE terminal — **emit the partial to stdout + a loud `WARNING: PARTIAL OUTPUT` banner to stderr + exit 1**. Removes the pre-existing failover-after-output (C), blind `--continue` into an empty session (B), and fresh-re-run (D) bugs, and supersedes the old D2 no-emit rule (the banner is what makes emitting the partial safe). Banner on stderr, not wrapping stdout, so stdout stays machine-clean.
- **E/Q2 (owner decision):** new `terminalText` on `PiRunOutcome` (Task 4b) so the nonce gate reads the genuinely-final block, not a marker left in a non-terminal `message_update`.
- **G:** spec §5 clarified that outage-`recovered` does not consume a resume attempt on the *outage-retry* path, but a resume that waited out an outage inside `resumeOrTerminal` *does*.
- **H:** per-candidate worst-case wall-clock corrected to `(resumeAttempts + 1 + MAX_OUTAGE_RETRIES) × OVERALL_TIMEOUT_MS` (Deviation 3).
- **I/Q3 (owner decision):** cli warns (not rejects) when `idle_timeout_seconds ≤ 300`.
- **F:** spec signature/components/§11 updated to the `throttled` enum (later trimmed to 3-state `up/down/throttled` by spike AR-2 — `auth` dropped).
- **J / minors:** preserved the "after producing output" diagnostic; strengthened `pausedMs > 0` → `=== 1000`; added tests for the throttled label, the `MAX_OUTAGE_RETRIES` bound, the idle+overall-timeout precedence (D5), the non-terminal-nonce case (E), and the B/C/D partial terminals; Task 0 Step 2 now records the session artifact extension (MEDIUM-2).
- **Accepted / not changed:** post-output *hard* failure (clean 4xx/fatal) stays `fatal` no-emit (distinct from the resumable partial family); `describe()` duplication (NIT) and `encodeURIComponent` readability (NIT) left as-is.
```
