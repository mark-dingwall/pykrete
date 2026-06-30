# Failover State Machine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consume Spec A's resolved `(candidates, intendedLead, prompt)` and run it — launch `pi -p` against candidate model ids in order, classify each terminal outcome, fail over on pre-output model-unavailability, and surface the result with a caller-facing exit-code contract.

**Architecture:** Five small pure-or-injectable modules + a bin rewrite. `pi-events` parses pi's `--mode json` stream into a terminal outcome; `classify` maps an outcome to a verdict; `agentdir` writes the per-invocation `models.json`; `launch` spawns one `pi` attempt with startup/overall watchdogs; `failover` is the pure state machine over injected attempts. `bin/pykrete.ts` composes Spec A's `run()` with `runFailover`.

**Tech Stack:** TypeScript run natively via `node --experimental-strip-types`; tests via `node:test` + `node:assert/strict`; `node:child_process`, `node:readline`, `node:fs`, `node:os`. No new runtime dependencies.

## Global Constraints

- **Reliability is prime:** nothing may stop a run except an unrecoverable cause. Only **pre-output model-unavailability** triggers failover; **fatal** = `401`/`402`/config/arg only; ambiguous pre-output errors **default to failover**.
- **Pre-output failover only:** once a candidate has produced assistant output, a later failure is **surfaced, never restarted** (would discard work).
- **stdout = run result only.** All Pykrete diagnostics go to **stderr**. In `--mode json` the child's stdout is an event stream, so Pykrete reconstructs the assistant result text and writes that to its own stdout (live token streaming is explicitly deferred).
- **Exit codes:** `0` success on intended lead; `3` success but substituted (`launchedId ≠ intendedLead`); `4` family unavailable (all candidates cleanly model-unavailable); `1` other run failure (fatal, transient, post-output death, deadline, or mixed/unclassifiable exhaustion); `2` config/arg/family error (already emitted by `bin`).
- **Pykrete must NOT infer or decompose tasks.** It launches what Spec A resolved, nothing more.
- **Transport:** `pi -p --mode json --no-session --offline --provider nanogpt --model <id> <prompt>`. `--offline` disables pi's startup network ops (the cause of the intermittent ~2min startup stall) — inference still reaches NanoGPT and Pykrete does its own catalog fetch, so pi's startup chores are unneeded. The child's agent dir is a per-invocation temp dir via `PI_CODING_AGENT_DIR`, holding a generated `models.json` (registers all candidate ids as a NanoGPT `openai-completions` provider) and a `settings.json` (pins pi's native same-model transient retry on; verified pi loads it without complaint).
- **Transient retry is pi's job, not Pykrete's:** pi self-retries `429`/`5xx`/overloaded outcomes on the same model and session with backoff + `Retry-After`. Pykrete only pins/tunes that via `settings.json`; it never reimplements backoff, and `transient → surface (exit 1)` fires only after pi has exhausted its own retries (a genuine account/endpoint outage, where degrading to another model would not help).
- **Heartbeat (opt-in):** `PYKRETE_HEARTBEAT_SECONDS` env, default off. When set, Pykrete emits a structured JSON heartbeat line to **stderr** every interval (`{"pykrete":"heartbeat","candidate","elapsed_s","events","idle_s"}`), driven by pi's streamed events so the caller sees both wrapper-alive and pi-progress. Informational only; it never kills.
- **pi binary:** resolved from `PYKRETE_PI_BIN` env (default `pi` on PATH). Tests point it at a fake-pi fixture script.
- Node engines `>=22.18`. `.ts` ESM imports with extensions. `strict` typechecking. Match Spec A's style: small focused files, co-located `*.test.ts`, IO injected for testability, `unknown`+narrowing over `any`.
- Test command: `npm test` (`node --experimental-strip-types --test 'src/**/*.test.ts'`). Typecheck: `npm run typecheck` (`tsc --noEmit`). Only `src/**/*.test.ts` are collected, so bin integration tests live in `src/`.

---

### Task 1: Agent-dir + models.json + settings.json generator

**Files:**
- Create: `src/agentdir.ts`
- Test: `src/agentdir.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces: `buildModelsJson(candidates: string[], opts?: { baseUrl?: string; apiKeyRef?: string }): unknown`; `buildSettingsJson(): unknown`; `createAgentDir(modelsJson: unknown, settingsJson: unknown): { dir: string; cleanup(): void }`.

**Why settings.json:** Pykrete owns the child's isolated agent dir, so it pins pi's native transient-retry behaviour here rather than reimplementing backoff. pi already retries `isRetryableAssistantError` outcomes (429/5xx/overloaded) on the **same model and session** with backoff, honouring `Retry-After` up to `maxRetryDelayMs`. Keys verified in pi `settings-manager.ts`: `retry.enabled` (default true), `retry.maxRetries` (default 3), `retry.baseDelayMs` (default 2000), `retry.provider.maxRetryDelayMs` (default 60000). Pinning them makes the behaviour explicit and the future tuning knob obvious; it also guards against pi's defaults drifting.

- [ ] **Step 1: Write the failing test**

```ts
// src/agentdir.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildModelsJson, buildSettingsJson, createAgentDir } from "./agentdir.ts";

test("buildModelsJson registers all candidates under a nanogpt openai-completions provider", () => {
  const json = buildModelsJson(["a/b", "c/d"]) as {
    providers: { nanogpt: { baseUrl: string; api: string; apiKey: string; authHeader: boolean; models: { id: string }[] } };
  };
  const p = json.providers.nanogpt;
  assert.equal(p.baseUrl, "https://nano-gpt.com/api/v1");
  assert.equal(p.api, "openai-completions");
  assert.equal(p.apiKey, "$NANOGPT_API_KEY");
  assert.equal(p.authHeader, true);
  assert.deepEqual(p.models, [{ id: "a/b" }, { id: "c/d" }]);
});

test("buildModelsJson honours baseUrl and apiKeyRef overrides", () => {
  const json = buildModelsJson(["x"], { baseUrl: "http://local/v1", apiKeyRef: "$OTHER" }) as {
    providers: { nanogpt: { baseUrl: string; apiKey: string } };
  };
  assert.equal(json.providers.nanogpt.baseUrl, "http://local/v1");
  assert.equal(json.providers.nanogpt.apiKey, "$OTHER");
});

test("buildSettingsJson pins pi native same-model transient retry on", () => {
  const json = buildSettingsJson() as { retry: { enabled: boolean; maxRetries: number; baseDelayMs: number; provider: { maxRetryDelayMs: number } } };
  assert.equal(json.retry.enabled, true);
  assert.equal(json.retry.maxRetries, 3);
  assert.equal(json.retry.baseDelayMs, 2000);
  assert.equal(json.retry.provider.maxRetryDelayMs, 60000);
});

test("createAgentDir writes models.json + settings.json and cleanup removes the dir", () => {
  const models = buildModelsJson(["a/b"]);
  const settings = buildSettingsJson();
  const agent = createAgentDir(models, settings);
  assert.deepEqual(JSON.parse(readFileSync(join(agent.dir, "models.json"), "utf-8")), models);
  assert.deepEqual(JSON.parse(readFileSync(join(agent.dir, "settings.json"), "utf-8")), settings);
  agent.cleanup();
  assert.ok(!existsSync(agent.dir));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test src/agentdir.test.ts`
Expected: FAIL — `Cannot find module './agentdir.ts'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/agentdir.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface NanogptProviderOptions {
  baseUrl?: string;
  apiKeyRef?: string;
}

export function buildModelsJson(candidates: string[], opts: NanogptProviderOptions = {}): unknown {
  return {
    providers: {
      nanogpt: {
        baseUrl: opts.baseUrl ?? "https://nano-gpt.com/api/v1",
        api: "openai-completions",
        apiKey: opts.apiKeyRef ?? "$NANOGPT_API_KEY",
        authHeader: true,
        models: candidates.map((id) => ({ id })),
      },
    },
  };
}

// Pin pi's native transient retry (same model, same session, backoff + Retry-After).
// These match pi's documented defaults; centralised here as the tuning knob.
export function buildSettingsJson(): unknown {
  return {
    retry: {
      enabled: true,
      maxRetries: 3,
      baseDelayMs: 2000,
      provider: { maxRetryDelayMs: 60000 },
    },
  };
}

export interface AgentDir {
  dir: string;
  cleanup(): void;
}

export function createAgentDir(modelsJson: unknown, settingsJson: unknown): AgentDir {
  const dir = mkdtempSync(join(tmpdir(), "pykrete-agent-"));
  writeFileSync(join(dir, "models.json"), JSON.stringify(modelsJson, null, 2));
  writeFileSync(join(dir, "settings.json"), JSON.stringify(settingsJson, null, 2));
  return {
    dir,
    cleanup() {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort; a leaked temp dir is harmless
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test src/agentdir.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agentdir.ts src/agentdir.test.ts
git commit -m "feat: per-invocation pi agent dir with models.json + retry-pinned settings.json"
```

---

### Task 2: pi `--mode json` event accumulator

**Files:**
- Create: `src/pi-events.ts`
- Test: `src/pi-events.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces: `interface PiRunOutcome { stopReason?: string; errorMessage?: string; model?: string; text: string; sawAssistantOutput: boolean }`; `interface PiEventsAccumulator { push(line: string): void; result(): PiRunOutcome }`; `createPiEventsAccumulator(): PiEventsAccumulator`.

Notes on pi's stream (verified empirically 2026-06-29): each event is one JSON line; the terminal assistant turn appears as `{"type":"message_end","message":{"role":"assistant","model":"<id>","content":[...],"stopReason":"stop|error|...","errorMessage":"..."}}`. A failed call has `content:[]` and `stopReason:"error"`. The accumulator must tolerate non-JSON lines and lines without a `message`.

- [ ] **Step 1: Write the failing test**

```ts
// src/pi-events.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPiEventsAccumulator } from "./pi-events.ts";

function feed(lines: string[]) {
  const acc = createPiEventsAccumulator();
  for (const l of lines) acc.push(l);
  return acc.result();
}

test("success run: captures stop reason, model, and reconstructed text", () => {
  const r = feed([
    `{"type":"session","id":"x"}`,
    `{"type":"agent_start"}`,
    `{"type":"message_end","message":{"role":"assistant","model":"openai/gpt-5-nano","content":[{"type":"text","text":"PONG"}],"stopReason":"stop"}}`,
  ]);
  assert.equal(r.stopReason, "stop");
  assert.equal(r.model, "openai/gpt-5-nano");
  assert.equal(r.text, "PONG");
  assert.equal(r.sawAssistantOutput, true);
});

test("model-unavailable error: empty content, error stop reason, no output seen", () => {
  const r = feed([
    `{"type":"message_end","message":{"role":"assistant","model":"bad/id","content":[],"stopReason":"error","errorMessage":"400 Model bad/id is not supported on /v1/chat/completions."}}`,
  ]);
  assert.equal(r.stopReason, "error");
  assert.equal(r.errorMessage, "400 Model bad/id is not supported on /v1/chat/completions.");
  assert.equal(r.text, "");
  assert.equal(r.sawAssistantOutput, false);
});

test("output-then-error: sawAssistantOutput stays true across turns", () => {
  const r = feed([
    `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"working..."}],"stopReason":"stop"}}`,
    `{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"400 Model x not supported"}}`,
  ]);
  assert.equal(r.sawAssistantOutput, true);
  assert.equal(r.stopReason, "error");
});

test("tolerates non-JSON and message-less lines", () => {
  const r = feed([`not json`, `{"type":"heartbeat"}`, `{"message":{"role":"user","content":[]}}`]);
  assert.equal(r.stopReason, undefined);
  assert.equal(r.sawAssistantOutput, false);
  assert.equal(r.text, "");
});

test("tool activity counts as output even without assistant text", () => {
  const r = feed([`{"type":"turn_end","toolResults":[{"ok":true}]}`]);
  assert.equal(r.sawAssistantOutput, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test src/pi-events.test.ts`
Expected: FAIL — `Cannot find module './pi-events.ts'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/pi-events.ts
export interface PiRunOutcome {
  stopReason?: string;
  errorMessage?: string;
  model?: string;
  text: string;
  sawAssistantOutput: boolean;
}

export interface PiEventsAccumulator {
  push(line: string): void;
  result(): PiRunOutcome;
}

type RawContent = { type?: unknown; text?: unknown };
type RawMessage = { role?: unknown; stopReason?: unknown; errorMessage?: unknown; model?: unknown; content?: unknown };
type RawEvent = { message?: RawMessage; toolResults?: unknown };

export function createPiEventsAccumulator(): PiEventsAccumulator {
  let stopReason: string | undefined;
  let errorMessage: string | undefined;
  let model: string | undefined;
  let text = "";
  let sawAssistantOutput = false;

  function handleAssistant(msg: RawMessage): void {
    if (typeof msg.stopReason === "string") stopReason = msg.stopReason;
    if (typeof msg.errorMessage === "string") errorMessage = msg.errorMessage;
    if (typeof msg.model === "string") model = msg.model;
    const content = Array.isArray(msg.content) ? (msg.content as RawContent[]) : [];
    let turnText = "";
    for (const c of content) {
      if (c && c.type === "text" && typeof c.text === "string") turnText += c.text;
    }
    if (turnText.length > 0) {
      sawAssistantOutput = true;
      text = turnText;
    }
  }

  return {
    push(line: string): void {
      let obj: RawEvent;
      try {
        obj = JSON.parse(line) as RawEvent;
      } catch {
        return;
      }
      if (!obj || typeof obj !== "object") return;
      if (obj.message && obj.message.role === "assistant") handleAssistant(obj.message);
      if (Array.isArray(obj.toolResults) && obj.toolResults.length > 0) sawAssistantOutput = true;
    },
    result(): PiRunOutcome {
      return { stopReason, errorMessage, model, text, sawAssistantOutput };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test src/pi-events.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/pi-events.ts src/pi-events.test.ts
git commit -m "feat: accumulator for pi --mode json terminal outcome"
```

---

### Task 3: Outcome classifier

**Files:**
- Create: `src/classify.ts`
- Test: `src/classify.test.ts`

**Interfaces:**
- Consumes: `PiRunOutcome` from `./pi-events.ts`.
- Produces: `type Verdict = { kind: "success" } | { kind: "model-unavailable" } | { kind: "fatal"; message: string } | { kind: "transient"; message: string } | { kind: "ambiguous"; message: string }`; `parseStatus(errorMessage: string): number | undefined`; `classify(outcome: PiRunOutcome, flags: { startupTimedOut: boolean; overallTimedOut: boolean }): Verdict`.

Classifier policy (from Spec B's confirmed NanoGPT taxonomy):
- startup timeout → `model-unavailable` (pre-output stall, try next); overall timeout → `transient`.
- no terminal `stopReason` → `ambiguous` (default-failover bias).
- `stopReason` `stop`/`length` → `success`; `aborted` → `transient`.
- `stopReason` `error`, parse leading HTTP status from `errorMessage`: `401`/`402` → `fatal`; `403`/`404` → `model-unavailable`; `400` → `model-unavailable` iff the message references the model, else `fatal`; `408`/`429`/`≥500` → `transient`; otherwise → `ambiguous`.

- [ ] **Step 1: Write the failing test**

```ts
// src/classify.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, parseStatus } from "./classify.ts";
import type { PiRunOutcome } from "./pi-events.ts";

const ok = { startupTimedOut: false, overallTimedOut: false };
function out(o: Partial<PiRunOutcome>): PiRunOutcome {
  return { text: "", sawAssistantOutput: false, ...o };
}

test("parseStatus reads a leading 3-digit status", () => {
  assert.equal(parseStatus("400 Model x not supported"), 400);
  assert.equal(parseStatus("401 Invalid session"), 401);
  assert.equal(parseStatus("no status here"), undefined);
});

test("stop and length are success", () => {
  assert.equal(classify(out({ stopReason: "stop" }), ok).kind, "success");
  assert.equal(classify(out({ stopReason: "length" }), ok).kind, "success");
});

test("400 referencing the model is model-unavailable", () => {
  const v = classify(out({ stopReason: "error", model: "bad/id", errorMessage: "400 Model bad/id is not supported on /v1/chat/completions." }), ok);
  assert.equal(v.kind, "model-unavailable");
});

test("400 without a model reference is fatal", () => {
  const v = classify(out({ stopReason: "error", errorMessage: "400 messages: field required" }), ok);
  assert.equal(v.kind, "fatal");
});

test("401 and 402 are fatal; 403 and 404 are model-unavailable", () => {
  assert.equal(classify(out({ stopReason: "error", errorMessage: "401 Invalid session" }), ok).kind, "fatal");
  assert.equal(classify(out({ stopReason: "error", errorMessage: "402 Insufficient balance" }), ok).kind, "fatal");
  assert.equal(classify(out({ stopReason: "error", errorMessage: "403 permission_denied_error" }), ok).kind, "model-unavailable");
  assert.equal(classify(out({ stopReason: "error", errorMessage: "404 not_found_error" }), ok).kind, "model-unavailable");
});

test("429 and 5xx are transient", () => {
  assert.equal(classify(out({ stopReason: "error", errorMessage: "429 rate_limit_error" }), ok).kind, "transient");
  assert.equal(classify(out({ stopReason: "error", errorMessage: "503 service_unavailable" }), ok).kind, "transient");
});

test("error with unparseable status is ambiguous", () => {
  assert.equal(classify(out({ stopReason: "error", errorMessage: "connection reset" }), ok).kind, "ambiguous");
});

test("no terminal stopReason is ambiguous", () => {
  assert.equal(classify(out({}), ok).kind, "ambiguous");
});

test("aborted is transient", () => {
  assert.equal(classify(out({ stopReason: "aborted" }), ok).kind, "transient");
});

test("startup timeout is model-unavailable; overall timeout is transient", () => {
  assert.equal(classify(out({}), { startupTimedOut: true, overallTimedOut: false }).kind, "model-unavailable");
  assert.equal(classify(out({}), { startupTimedOut: false, overallTimedOut: true }).kind, "transient");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test src/classify.test.ts`
Expected: FAIL — `Cannot find module './classify.ts'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/classify.ts
import type { PiRunOutcome } from "./pi-events.ts";

export type Verdict =
  | { kind: "success" }
  | { kind: "model-unavailable" }
  | { kind: "fatal"; message: string }
  | { kind: "transient"; message: string }
  | { kind: "ambiguous"; message: string };

export function parseStatus(errorMessage: string): number | undefined {
  const m = /^\s*(\d{3})\b/.exec(errorMessage);
  return m ? Number(m[1]) : undefined;
}

function modelReferenced(errorMessage: string, launchedId: string | undefined): boolean {
  if (launchedId && errorMessage.includes(launchedId)) return true;
  return /not supported|does not exist|model_not_supported|unknown model|\bmodel\b/i.test(errorMessage);
}

export function classify(
  outcome: PiRunOutcome,
  flags: { startupTimedOut: boolean; overallTimedOut: boolean },
): Verdict {
  if (flags.startupTimedOut) return { kind: "model-unavailable" };
  if (flags.overallTimedOut) return { kind: "transient", message: "attempt timed out" };

  const { stopReason, errorMessage, model } = outcome;
  if (stopReason === undefined) return { kind: "ambiguous", message: "no terminal message from pi" };
  if (stopReason === "stop" || stopReason === "length") return { kind: "success" };
  if (stopReason === "aborted") return { kind: "transient", message: "run aborted" };

  const message = errorMessage ?? "unknown error";
  const status = parseStatus(message);
  if (status === 401 || status === 402) return { kind: "fatal", message };
  if (status === 403 || status === 404) return { kind: "model-unavailable" };
  if (status === 400) return modelReferenced(message, model) ? { kind: "model-unavailable" } : { kind: "fatal", message };
  if (status === 408 || status === 429 || (status !== undefined && status >= 500)) return { kind: "transient", message };
  return { kind: "ambiguous", message };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test src/classify.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/classify.ts src/classify.test.ts
git commit -m "feat: classify pi terminal outcome into failover verdict"
```

---

### Task 4: Single-attempt launcher with watchdogs

**Files:**
- Create: `src/launch.ts`
- Create: `src/test-fixtures/fake-pi.mjs` (test double; not collected by the test glob)
- Test: `src/launch.test.ts`

**Interfaces:**
- Consumes: `createPiEventsAccumulator`, `PiRunOutcome` from `./pi-events.ts`.
- Produces: `interface HeartbeatInfo { candidate: string; elapsedMs: number; events: number; idleMs: number }`; `interface AttemptOutcome { outcome: PiRunOutcome; startupTimedOut: boolean; overallTimedOut: boolean; exitCode: number | null; signal: NodeJS.Signals | null; stderr: string }`; `interface LaunchOptions { candidate: string; prompt: string; agentDir: string; apiKey?: string; startupTimeoutMs: number; overallTimeoutMs: number; piBin?: string; heartbeatMs?: number; heartbeat?: (info: HeartbeatInfo) => void }`; `launchAttempt(opts: LaunchOptions): Promise<AttemptOutcome>`.

Behaviour: spawn `pi -p --mode json --no-session --provider nanogpt --model <candidate> <prompt>` with `PI_CODING_AGENT_DIR=agentDir` and (if set) `NANOGPT_API_KEY=apiKey` in the child env, cwd inherited. Read stdout line-by-line into the accumulator. A **startup timer** (`startupTimeoutMs`) fires if no stdout line arrives — kill `SIGTERM`, set `startupTimedOut`; it is cleared on the first line. An **overall timer** (`overallTimeoutMs`) always bounds the attempt — kill `SIGTERM`, set `overallTimedOut`. Resolve on child `close`/`error`.

**Heartbeat (liveness for the caller):** pi streams json events incrementally (verified — `session`/`agent_start` ~700 ms, then `message_update` token deltas and `tool_execution_*` throughout). Track an `events` counter (one per stdout line) and `lastEventAt`. If `heartbeatMs` and `heartbeat` are supplied, an interval timer calls `heartbeat({ candidate, elapsedMs, events, idleMs })` every `heartbeatMs` — `events` rising means pi is progressing; `idleMs` (time since last event) rising means it is stalled even before the overall timer fires. Cleared on finish. Informational only — it does not kill (the startup/overall timers own that).

- [ ] **Step 1: Write the fake-pi fixture**

```js
// src/test-fixtures/fake-pi.mjs
#!/usr/bin/env node
// Minimal pi stand-in. Chooses a scenario from the --model value and emits
// pi-style JSON lines on stdout. Used only by launch.test.ts / bin.test.ts.
const argv = process.argv.slice(2);
let model = "";
for (let i = 0; i < argv.length; i++) if (argv[i] === "--model") model = argv[i + 1] ?? "";

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const assistant = (fields) => emit({ type: "message_end", message: { role: "assistant", model, ...fields } });

if (model.includes("stall")) {
  // never emit anything -> triggers startup timeout
  setTimeout(() => {}, 10_000);
} else if (model.includes("hang")) {
  emit({ type: "agent_start" }); // disarms startup timer, then hangs -> overall timeout
  setTimeout(() => {}, 10_000);
} else if (model.includes("bad400")) {
  assistant({ content: [], stopReason: "error", errorMessage: `400 Model ${model} is not supported on /v1/chat/completions.` });
} else if (model.includes("auth401")) {
  assistant({ content: [], stopReason: "error", errorMessage: "401 Invalid session" });
} else if (model.includes("rate429")) {
  assistant({ content: [], stopReason: "error", errorMessage: "429 rate_limit_error" });
} else if (model.includes("midrun")) {
  assistant({ content: [{ type: "text", text: "PARTIAL" }], stopReason: "stop" });
  assistant({ content: [], stopReason: "error", errorMessage: `400 Model ${model} is not supported` });
} else {
  emit({ type: "agent_start" });
  assistant({ content: [{ type: "text", text: "RESULT-OK" }], stopReason: "stop" });
  emit({ type: "agent_end" });
}
```

- [ ] **Step 2: Write the failing test**

```ts
// src/launch.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { launchAttempt } from "./launch.ts";

const FAKE = fileURLToPath(new URL("./test-fixtures/fake-pi.mjs", import.meta.url));
chmodSync(FAKE, 0o755);

function base(candidate: string) {
  return { candidate, prompt: "hi", agentDir: "/tmp", piBin: FAKE, startupTimeoutMs: 1000, overallTimeoutMs: 2000 };
}

test("success scenario yields stop reason and reconstructed text", async () => {
  const r = await launchAttempt(base("good-ok"));
  assert.equal(r.outcome.stopReason, "stop");
  assert.equal(r.outcome.text, "RESULT-OK");
  assert.equal(r.startupTimedOut, false);
  assert.equal(r.exitCode, 0);
});

test("model-unavailable scenario surfaces the 400 error string", async () => {
  const r = await launchAttempt(base("bad400"));
  assert.equal(r.outcome.stopReason, "error");
  assert.match(r.outcome.errorMessage ?? "", /^400 Model bad400/);
  assert.equal(r.outcome.sawAssistantOutput, false);
});

test("startup stall trips the startup watchdog", async () => {
  const r = await launchAttempt({ ...base("stall"), startupTimeoutMs: 200, overallTimeoutMs: 5000 });
  assert.equal(r.startupTimedOut, true);
  assert.equal(r.outcome.sawAssistantOutput, false);
});

test("post-startup hang trips the overall watchdog, not the startup one", async () => {
  const r = await launchAttempt({ ...base("hang"), startupTimeoutMs: 1000, overallTimeoutMs: 300 });
  assert.equal(r.startupTimedOut, false);
  assert.equal(r.overallTimedOut, true);
});

test("heartbeat fires periodically with the candidate and a rising clock", async () => {
  const beats: { candidate: string; elapsedMs: number; events: number; idleMs: number }[] = [];
  await launchAttempt({
    ...base("hang"),
    startupTimeoutMs: 1000,
    overallTimeoutMs: 350,
    heartbeatMs: 50,
    heartbeat: (info) => beats.push(info),
  });
  assert.ok(beats.length >= 1, "expected at least one heartbeat");
  assert.equal(beats[0].candidate, "hang");
  assert.ok(beats[beats.length - 1].elapsedMs >= beats[0].elapsedMs);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --experimental-strip-types --test src/launch.test.ts`
Expected: FAIL — `Cannot find module './launch.ts'`.

- [ ] **Step 4: Write minimal implementation**

```ts
// src/launch.ts
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createPiEventsAccumulator, type PiRunOutcome } from "./pi-events.ts";

export interface HeartbeatInfo {
  candidate: string;
  elapsedMs: number;
  events: number;
  idleMs: number;
}

export interface LaunchOptions {
  candidate: string;
  prompt: string;
  agentDir: string;
  apiKey?: string;
  startupTimeoutMs: number;
  overallTimeoutMs: number;
  piBin?: string;
  heartbeatMs?: number;
  heartbeat?: (info: HeartbeatInfo) => void;
}

export interface AttemptOutcome {
  outcome: PiRunOutcome;
  startupTimedOut: boolean;
  overallTimedOut: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

export function launchAttempt(opts: LaunchOptions): Promise<AttemptOutcome> {
  const piBin = opts.piBin ?? process.env.PYKRETE_PI_BIN ?? "pi";
  // --offline disables pi's startup network ops (the cause of the non-deterministic ~2min
  // startup stall); inference still reaches NanoGPT, and Pykrete does its own catalog fetch,
  // so pi's startup chores are pure liability here. Verified: a run with --offline returns
  // normally. The startup watchdog remains as a backstop.
  const args = [
    "-p", "--mode", "json", "--no-session", "--offline",
    "--provider", "nanogpt", "--model", opts.candidate,
    opts.prompt,
  ];
  const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: opts.agentDir };
  if (opts.apiKey !== undefined) env.NANOGPT_API_KEY = opts.apiKey;

  const child = spawn(piBin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  const acc = createPiEventsAccumulator();
  const startedAt = Date.now();
  let stderr = "";
  let startupTimedOut = false;
  let overallTimedOut = false;
  let firstLineSeen = false;
  let events = 0;
  let lastEventAt = startedAt;

  return new Promise<AttemptOutcome>((resolve) => {
    const startupTimer = setTimeout(() => {
      startupTimedOut = true;
      child.kill("SIGTERM");
    }, opts.startupTimeoutMs);
    const overallTimer = setTimeout(() => {
      overallTimedOut = true;
      child.kill("SIGTERM");
    }, opts.overallTimeoutMs);
    // Heartbeat is best-effort and MUST NOT stop the run: a throw here (e.g. stderr EPIPE)
    // is swallowed. idleMs is observational only — the launcher never kills on idle, because
    // a stall is indistinguishable at the stdout level from pi's legitimate retry backoff;
    // the overall timer owns the hard bound.
    const heartbeatTimer =
      opts.heartbeatMs && opts.heartbeat
        ? setInterval(() => {
            const now = Date.now();
            try {
              opts.heartbeat!({ candidate: opts.candidate, elapsedMs: now - startedAt, events, idleMs: now - lastEventAt });
            } catch {
              // never let a heartbeat failure abort the run
            }
          }, opts.heartbeatMs)
        : undefined;

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(startupTimer);
      clearTimeout(overallTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      resolve({ outcome: acc.result(), startupTimedOut, overallTimedOut, exitCode, signal, stderr });
    };

    if (child.stdout) {
      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        if (!firstLineSeen) {
          firstLineSeen = true;
          clearTimeout(startupTimer);
        }
        events += 1;
        lastEventAt = Date.now();
        acc.push(line);
      });
    }
    if (child.stderr) child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    child.on("close", (code, signal) => finish(code, signal));
    child.on("error", () => finish(null, null));
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --experimental-strip-types --test src/launch.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/launch.ts src/launch.test.ts src/test-fixtures/fake-pi.mjs
git commit -m "feat: single pi -p attempt launcher with watchdogs + streaming heartbeat"
```

---

### Task 5: Failover state machine

**Files:**
- Create: `src/failover.ts`
- Test: `src/failover.test.ts`

**Interfaces:**
- Consumes: `classify`, `Verdict` from `./classify.ts`; `AttemptOutcome` from `./launch.ts`; `PiRunOutcome` from `./pi-events.ts`.
- Produces: `interface FailoverPlan { candidates: string[]; intendedLead: string; prompt: string }`; `interface FailoverDeps { launchAttempt: (candidate: string, overallTimeoutMs: number) => Promise<AttemptOutcome>; now: () => number; warn: (msg: string) => void; emit: (text: string) => void; overallTimeoutMs?: number; deadlineMs?: number }`; `interface FailoverResult { exitCode: number; launchedId?: string }`; `runFailover(plan: FailoverPlan, deps: FailoverDeps): Promise<FailoverResult>`.

State machine (per Global Constraints): iterate candidates within the aggregate deadline. On each attempt's verdict — `success` → emit text, exit `0` (lead) or `3` (substituted). If the attempt produced output, any non-success → surface, exit `1` (no failover). Pre-output: `fatal`/`transient` → surface, exit `1` (stop). `model-unavailable`/`ambiguous` → fail over; record whether all were cleanly model-unavailable. Deadline hit → exit `1`. Exhausted: all clean model-unavailable → exit `4`, else exit `1`.

- [ ] **Step 1: Write the failing test**

```ts
// src/failover.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { runFailover, type FailoverDeps } from "./failover.ts";
import type { AttemptOutcome } from "./launch.ts";
import type { PiRunOutcome } from "./pi-events.ts";

function outcome(o: Partial<PiRunOutcome>, extra: Partial<AttemptOutcome> = {}): AttemptOutcome {
  return {
    outcome: { text: "", sawAssistantOutput: false, ...o },
    startupTimedOut: false,
    overallTimedOut: false,
    exitCode: 0,
    signal: null,
    stderr: "",
    ...extra,
  };
}

function deps(scripted: Record<string, AttemptOutcome>, sink: { out: string[]; warn: string[] }): FailoverDeps {
  return {
    launchAttempt: (candidate) => Promise.resolve(scripted[candidate]),
    now: () => 0,
    warn: (m) => sink.warn.push(m),
    emit: (t) => sink.out.push(t),
  };
}

test("lead succeeds -> exit 0, result emitted", async () => {
  const sink = { out: [] as string[], warn: [] as string[] };
  const r = await runFailover(
    { candidates: ["lead", "b"], intendedLead: "lead", prompt: "p" },
    deps({ lead: outcome({ stopReason: "stop", text: "ANS", sawAssistantOutput: true }) }, sink),
  );
  assert.equal(r.exitCode, 0);
  assert.deepEqual(sink.out, ["ANS"]);
});

test("lead model-unavailable, second succeeds -> exit 3 (substituted)", async () => {
  const sink = { out: [] as string[], warn: [] as string[] };
  const r = await runFailover(
    { candidates: ["lead", "b"], intendedLead: "lead", prompt: "p" },
    deps(
      {
        lead: outcome({ stopReason: "error", model: "lead", errorMessage: "400 Model lead not supported" }),
        b: outcome({ stopReason: "stop", text: "ANS", sawAssistantOutput: true }),
      },
      sink,
    ),
  );
  assert.equal(r.exitCode, 3);
  assert.equal(r.launchedId, "b");
});

test("all model-unavailable -> exit 4 (family unavailable)", async () => {
  const sink = { out: [] as string[], warn: [] as string[] };
  const r = await runFailover(
    { candidates: ["a", "b"], intendedLead: "a", prompt: "p" },
    deps(
      {
        a: outcome({ stopReason: "error", model: "a", errorMessage: "400 Model a not supported" }),
        b: outcome({ stopReason: "error", model: "b", errorMessage: "404 not_found_error" }),
      },
      sink,
    ),
  );
  assert.equal(r.exitCode, 4);
});

test("fatal on lead -> exit 1, no further attempts", async () => {
  const sink = { out: [] as string[], warn: [] as string[] };
  let bTried = false;
  const d: FailoverDeps = {
    launchAttempt: (c) => {
      if (c === "b") bTried = true;
      return Promise.resolve(
        c === "a"
          ? outcome({ stopReason: "error", errorMessage: "401 Invalid session" })
          : outcome({ stopReason: "stop", text: "X", sawAssistantOutput: true }),
      );
    },
    now: () => 0,
    warn: (m) => sink.warn.push(m),
    emit: (t) => sink.out.push(t),
  };
  const r = await runFailover({ candidates: ["a", "b"], intendedLead: "a", prompt: "p" }, d);
  assert.equal(r.exitCode, 1);
  assert.equal(bTried, false);
});

test("transient -> exit 1, stops (no failover)", async () => {
  const sink = { out: [] as string[], warn: [] as string[] };
  const r = await runFailover(
    { candidates: ["a", "b"], intendedLead: "a", prompt: "p" },
    deps({ a: outcome({ stopReason: "error", errorMessage: "503 service_unavailable" }) }, sink),
  );
  assert.equal(r.exitCode, 1);
});

test("post-output death -> exit 1, surfaced not failed over", async () => {
  const sink = { out: [] as string[], warn: [] as string[] };
  const r = await runFailover(
    { candidates: ["a", "b"], intendedLead: "a", prompt: "p" },
    deps(
      { a: outcome({ stopReason: "error", model: "a", errorMessage: "400 Model a not supported", sawAssistantOutput: true }) },
      sink,
    ),
  );
  assert.equal(r.exitCode, 1);
  assert.equal(r.launchedId, "a");
});

test("exhaustion with an ambiguous attempt -> exit 1, not 4", async () => {
  const sink = { out: [] as string[], warn: [] as string[] };
  const r = await runFailover(
    { candidates: ["a", "b"], intendedLead: "a", prompt: "p" },
    deps(
      {
        a: outcome({ stopReason: "error", model: "a", errorMessage: "400 Model a not supported" }),
        b: outcome({ stopReason: "error", errorMessage: "weird unparseable" }),
      },
      sink,
    ),
  );
  assert.equal(r.exitCode, 1);
});

test("deadline exceeded before an attempt -> exit 1", async () => {
  const sink = { out: [] as string[], warn: [] as string[] };
  let clock = 0;
  const d: FailoverDeps = {
    launchAttempt: () => {
      clock += 1000;
      return Promise.resolve(outcome({ stopReason: "error", model: "a", errorMessage: "400 Model a not supported" }));
    },
    now: () => clock,
    warn: (m) => sink.warn.push(m),
    emit: (t) => sink.out.push(t),
    deadlineMs: 500,
  };
  const r = await runFailover({ candidates: ["a", "b"], intendedLead: "a", prompt: "p" }, d);
  assert.equal(r.exitCode, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test src/failover.test.ts`
Expected: FAIL — `Cannot find module './failover.ts'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/failover.ts
import { classify, type Verdict } from "./classify.ts";
import type { AttemptOutcome } from "./launch.ts";

export interface FailoverPlan {
  candidates: string[];
  intendedLead: string;
  prompt: string;
}

export interface FailoverDeps {
  launchAttempt: (candidate: string, overallTimeoutMs: number) => Promise<AttemptOutcome>;
  now: () => number;
  warn: (msg: string) => void;
  emit: (text: string) => void;
  overallTimeoutMs?: number;
  deadlineMs?: number;
}

export interface FailoverResult {
  exitCode: number;
  launchedId?: string;
}

const DEFAULT_OVERALL_MS = 1_800_000;
const DEFAULT_DEADLINE_MS = 3_600_000;

function describe(v: Verdict): string {
  return "message" in v ? v.message : v.kind;
}

export async function runFailover(plan: FailoverPlan, deps: FailoverDeps): Promise<FailoverResult> {
  const overallTimeoutMs = deps.overallTimeoutMs ?? DEFAULT_OVERALL_MS;
  const deadlineMs = deps.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const start = deps.now();
  let allCleanModelUnavailable = true;

  for (const candidate of plan.candidates) {
    const remaining = deadlineMs - (deps.now() - start);
    if (remaining <= 0) {
      deps.warn(`pykrete: deadline exceeded before trying "${candidate}"`);
      return { exitCode: 1 };
    }

    const attempt = await deps.launchAttempt(candidate, Math.min(overallTimeoutMs, remaining));
    const verdict = classify(attempt.outcome, {
      startupTimedOut: attempt.startupTimedOut,
      overallTimedOut: attempt.overallTimedOut,
    });

    if (verdict.kind === "success") {
      deps.emit(attempt.outcome.text);
      const downgraded = candidate !== plan.intendedLead;
      if (downgraded) deps.warn(`pykrete: substituted "${candidate}" for intended lead "${plan.intendedLead}"`);
      return { exitCode: downgraded ? 3 : 0, launchedId: candidate };
    }

    if (attempt.outcome.sawAssistantOutput) {
      deps.warn(`pykrete: "${candidate}" failed after producing output: ${describe(verdict)}`);
      return { exitCode: 1, launchedId: candidate };
    }

    if (verdict.kind === "fatal") {
      deps.warn(`pykrete: fatal error on "${candidate}" (no failover): ${verdict.message}`);
      return { exitCode: 1, launchedId: candidate };
    }
    if (verdict.kind === "transient") {
      deps.warn(`pykrete: transient error on "${candidate}" (no failover): ${verdict.message}`);
      return { exitCode: 1, launchedId: candidate };
    }

    if (verdict.kind === "ambiguous") allCleanModelUnavailable = false;
    deps.warn(`pykrete: "${candidate}" unavailable, failing over: ${describe(verdict)}`);
  }

  if (allCleanModelUnavailable) {
    deps.warn("pykrete: all candidates unavailable; family appears unavailable");
    return { exitCode: 4 };
  }
  deps.warn("pykrete: all candidates failed (some unclassifiable)");
  return { exitCode: 1 };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test src/failover.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/failover.ts src/failover.test.ts
git commit -m "feat: pre-output failover state machine with exit-code contract"
```

---

### Task 6: Wire the binary + end-to-end integration test

**Files:**
- Modify: `bin/pykrete.ts` (replace the Spec A debug stub)
- Test: `src/bin.test.ts`
- Modify: `docs/superpowers/specs/2026-06-29-launcher-failover-design.md` (resolve the "Launch transport (open)" item; note the stdout-reconstruction decision)

**Interfaces:**
- Consumes: `run`, `RunResult` from `../src/cli.ts`; `ConfigError` from `../src/config.ts`; `FamilyError` from `../src/args.ts`; `buildModelsJson`, `createAgentDir` from `../src/agentdir.ts`; `launchAttempt` from `../src/launch.ts`; `runFailover` from `../src/failover.ts`.
- Produces: the `pykrete` CLI behaviour and exit codes.

- [ ] **Step 1: Write the failing integration test**

```ts
// src/bin.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/pykrete.ts", import.meta.url));
const FAKE = fileURLToPath(new URL("./test-fixtures/fake-pi.mjs", import.meta.url));
chmodSync(FAKE, 0o755);

function writeConfig(glm: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "pykrete-bin-"));
  const path = join(dir, "pykrete.toml");
  writeFileSync(
    path,
    ['default_family = "glm"', "[families]", `glm = [${glm.map((s) => `"${s}"`).join(", ")}]`].join("\n"),
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
    { encoding: "utf-8", env: { ...process.env, PYKRETE_PI_BIN: FAKE, NANOGPT_API_KEY: "" } },
  );
  assert.equal(r.status, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test src/bin.test.ts`
Expected: FAIL — the current `bin/pykrete.ts` prints the debug stub and exits 0, so the exit-code and stdout assertions fail.

- [ ] **Step 3: Replace `bin/pykrete.ts`**

```ts
// bin/pykrete.ts
#!/usr/bin/env node
import { run } from "../src/cli.ts";
import { ConfigError } from "../src/config.ts";
import { FamilyError } from "../src/args.ts";
import { buildModelsJson, buildSettingsJson, createAgentDir } from "../src/agentdir.ts";
import { launchAttempt, type HeartbeatInfo } from "../src/launch.ts";
import { runFailover } from "../src/failover.ts";

const STARTUP_TIMEOUT_MS = 180_000;
const OVERALL_TIMEOUT_MS = 1_800_000;

// Opt-in liveness for programmatic callers; off by default so interactive use stays quiet.
function heartbeatMsFromEnv(): number | undefined {
  const raw = process.env.PYKRETE_HEARTBEAT_SECONDS;
  if (raw === undefined || raw === "") return undefined;
  const secs = Number(raw);
  return Number.isFinite(secs) && secs > 0 ? secs * 1000 : undefined;
}

function emitHeartbeat(info: HeartbeatInfo): void {
  console.error(
    JSON.stringify({
      pykrete: "heartbeat",
      candidate: info.candidate,
      elapsed_s: Math.round(info.elapsedMs / 1000),
      events: info.events,
      idle_s: Math.round(info.idleMs / 1000),
    }),
  );
}

async function main(): Promise<number> {
  let resolved;
  try {
    resolved = await run(process.argv.slice(2));
  } catch (err) {
    if (err instanceof ConfigError || err instanceof FamilyError) {
      console.error(`pykrete: ${err.message}`);
      return 2;
    }
    throw err;
  }

  const prompt = resolved.prompt;
  if (prompt === undefined) {
    console.error("pykrete: no prompt provided");
    return 2;
  }

  const apiKey = process.env.NANOGPT_API_KEY;
  const heartbeatMs = heartbeatMsFromEnv();
  const agent = createAgentDir(buildModelsJson(resolved.candidates), buildSettingsJson());
  try {
    const result = await runFailover(
      { candidates: resolved.candidates, intendedLead: resolved.intendedLead, prompt },
      {
        launchAttempt: (candidate, overallTimeoutMs) =>
          launchAttempt({
            candidate,
            prompt,
            agentDir: agent.dir,
            apiKey,
            startupTimeoutMs: STARTUP_TIMEOUT_MS,
            overallTimeoutMs,
            heartbeatMs,
            heartbeat: heartbeatMs ? emitHeartbeat : undefined,
          }),
        now: Date.now,
        warn: (m) => console.error(m),
        emit: (text) => process.stdout.write(text.endsWith("\n") ? text : `${text}\n`),
      },
    );
    return result.exitCode;
  } finally {
    agent.cleanup();
  }
}

process.exitCode = await main();
```

Heartbeat behaviour is unit-tested in Task 4; the bin only maps `PYKRETE_HEARTBEAT_SECONDS` → the stderr emitter, so no extra bin test is required for it.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test src/bin.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Full suite + typecheck**

Run: `npm test`
Expected: PASS — all suites (Spec A's existing 47 + the new agentdir/pi-events/classify/launch/failover/bin tests).

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Reconcile the Spec B design doc**

In `docs/superpowers/specs/2026-06-29-launcher-failover-design.md`, under "Launch transport (open)", record the decision: **`pi -p` direct invocation chosen** (orchestrator deferred). Add lines under "Observability / streams" noting: in `--mode json`, Pykrete reconstructs the assistant result text from the terminal message and writes that to stdout (pi *does* stream events — incl. `message_update` token deltas — so live streaming is a cheap follow-up, deferred); failover is **pre-output only**; exit codes `0/3/4/1/2`; transient retry is delegated to pi's native retry (pinned via `settings.json`); opt-in `PYKRETE_HEARTBEAT_SECONDS` heartbeat to stderr.

- [ ] **Step 7: Commit**

```bash
git add bin/pykrete.ts src/bin.test.ts docs/superpowers/specs/2026-06-29-launcher-failover-design.md
git commit -m "feat: wire pykrete bin to failover state machine; resolve Spec B transport"
```

---

## Deferred (explicitly out of this plan)

These belong to follow-on plans, per the scope decision:
- **Sentinel nonce + resume** (liveness: silent-stop / truncation detection → `pi --continue`).
- **flat-edit.ts extension** integration (R3 fix) and per-model **compat flags**.
- **dataHarvesting** per-family warning (needs a config-schema addition).
- **Live token streaming** of the result to stdout — now cheap, since pi streams `message_update` token deltas; v1 emits the reconstructed final text.
- **Config-driven timeouts/deadline + retry budget** (v1 uses constants in `bin` / `failover` and the pinned `settings.json` retry values).
- **Telemetry capture** (backlogged per request): append one JSONL record per attempt to a Pykrete telemetry dir (e.g. `${XDG_STATE_HOME:-~/.local/state}/pykrete/attempts.jsonl`) with `{ts, candidate, intended_lead, verdict, elapsed_ms, events, startup_timed_out, overall_timed_out, exit_code}` — all already computed in `failover`/`launch`. Feeds the timeout-tuning loop and aligns with `docs/superpowers/specs/2026-06-29-stability-test-methodology.md` (anomaly bundles).
- **Pykrete-level same-model relaunch** beyond pi's internal retry, and an **idle/no-progress watchdog** (kill on `idleMs` exceeding a cap) — the heartbeat already surfaces `idle_s`; turning it into a kill policy is a follow-up.
- **stdin / `@files` prompt passthrough** fidelity.

## Self-Review

**Spec coverage** (against Spec B "Accepted requirements"): success→return + substitution signal ✓ (exit 0/3, Task 5/6); model-named 4xx→failover ✓ (classify 400/404, Task 3); per-model 403→failover ✓ (Task 3); terminal transient→surface no failover ✓ (Task 5) — and same-model transient *retry* before that is delegated to pi's native retry, pinned in `settings.json` (Task 1); non-model/fatal→surface ✓ (fatal, Task 5); ambiguous→default failover ✓ (Task 5); mixed-error exhaustion (don't claim family-dead with a non-clean attempt)→exit 1 not 4 ✓ (Task 5 `allCleanModelUnavailable`); exhausted all-unavailable→exit 4 naming family ✓; aggregate deadline ✓ (Task 5); stdout=result only / diagnostics→stderr ✓ (Global Constraints, Task 6 `emit`/`warn`); substitution exit code ✓; intended_lead baseline ✓; caller liveness via opt-in heartbeat ✓ (Task 4/6). Deferred items listed above. No gaps in the failover-state-machine scope.

**Placeholder scan:** no TBD/TODO; every code step shows complete code; every test step shows real assertions; commands have expected output.

**Type consistency:** `PiRunOutcome` (pi-events) is consumed unchanged by classify/launch/failover; `AttemptOutcome` (launch) embeds `.outcome: PiRunOutcome` and is consumed by failover; `HeartbeatInfo` (launch) is consumed by the bin emitter; `Verdict` (classify) consumed by failover; `FailoverPlan`/`FailoverDeps`/`FailoverResult` consumed by bin. `createAgentDir(modelsJson, settingsJson)` two-arg signature matches its single call site in `bin`. `launchAttempt` signature in `FailoverDeps` (`(candidate, overallTimeoutMs) => Promise<AttemptOutcome>`) matches the bin adapter, which calls the real `launchAttempt(LaunchOptions)` with `heartbeatMs`/`heartbeat` added. Exit-code integers (0/3/4/1/2) are consistent across Global Constraints, Task 5, and Task 6.
```
