# Pykrete launcher / failover — design (Spec B) — STUB

**Date:** 2026-06-29
**Status:** UNBLOCKED — pi error-surface investigation complete (2026-06-29, empirical; see
"pi error-surface findings" below). Ready to write the failover state machine against the
confirmed signatures. Residual unknowns (per-model 403, 429 string) flagged in the findings.
**Companion:** Spec A — family resolver (`2026-06-27-family-resolver-design.md`).

## Purpose

Consume the resolver's output from Spec A — `(ordered_candidate_list, intended_lead)` — and run
it: launch pi against candidates in order, fail over on model-unavailable, surface results, and
honour Contract 06-05 (caller passes prompt + args, gets reliable inference; a hiccup must never
stop a run). This is where each launch attempt is wrapped with the Branch-A wiring (compat flags,
`flat-edit.ts`, concurrency semaphore, sentinel nonce, dataHarvesting warning).

## Hard dependency (RESOLVED)

The failover state machine pivots on classifying pi's output as **model-unavailable** vs
**transient** vs **non-model failure**. pi's provider layer was just refactored (Models runtime,
provider factories, `createProvider`, compat entrypoint — ~360 commits). The exact error
signatures have now been read from current pi and confirmed live against NanoGPT — see
"pi error-surface findings (RESOLVED)" below. The classifier is no longer a placeholder.

## pi error-surface findings (RESOLVED — 2026-06-29, empirical)

Verified against `~/pi` (built `dist/cli.js`, ~360-commit refactored provider layer) AND a live
NanoGPT account. Method: register NanoGPT as a custom `openai-completions` provider, drive
`pi -p` with valid / unknown / bad-key model ids, observe exit code + stdout/stderr + json events.

### Wiring (how Pykrete launches pi against NanoGPT)

NanoGPT has **no native pi provider** and is **chat-completions** compatible, *not* the OpenAI
Responses API that pi's built-in `openai` provider uses. Register it as a custom provider:

- File: `$PI_CODING_AGENT_DIR/models.json` (env `PI_CODING_AGENT_DIR` overrides the default
  `~/.pi/agent` — lets Pykrete keep its own isolated agent dir).
- Shape (only `id` is required per model):
  ```json
  { "providers": { "nanogpt": {
      "baseUrl": "https://nano-gpt.com/api/v1",
      "api": "openai-completions",
      "apiKey": "$NANOGPT_API_KEY", "authHeader": true,
      "models": [ { "id": "openai/gpt-5-nano" } ] } } }
  ```
  `apiKey` supports `$ENV` interpolation, `!command`, or literal. `authHeader:true` sends
  `Authorization: Bearer <apiKey>`.
- Per-run selection: `pi -p --provider nanogpt --model <id> [--api-key <k>] --no-session [--no-tools]`.
- Each candidate id from Spec A must be a member of `models[]` (or registered at launch). All
  candidates are thus "known" to pi at startup; a dead id surfaces only at **request time**, not
  startup. (An id passed to `--model` that is NOT registered is a different, startup-time exit-1 path.)

### Output modes and the exit-code trap

| Mode | Clean run | Run-level model error | Startup/arg error |
|---|---|---|---|
| `--mode text` (default), `-p` | exit **0**, result → **stdout** | exit **1**, `errorMessage` → **stderr** (one line) | exit 1, message → stderr |
| `--mode json`, `-p` | exit **0**, JSONL events → **stdout** | exit **0** ⚠️, error is a `stopReason:"error"` event → **stdout** | exit 1 (thrown → catch) |

**The trap:** `print-mode.ts` sets `exitCode=1` for `stopReason==="error"/"aborted"` **only inside
`if (mode==="text")`**. A run-level error is a normal event, never a thrown exception, so **json
mode returns 0 even when the model call failed.** In json mode the exit code is useless for
success detection — Pykrete MUST inspect the final assistant message's `stopReason`.

Signals: SIGHUP → **129**, SIGTERM → **143**. There is **no distinct exit code** for
"model unavailable" — text mode collapses every run failure to **1**.

### The classification signal

Provider layer **discards HTTP status and error code** in its catch (`openai-completions.ts`),
flattening to a single `errorMessage` string + `stopReason:"error"`. BUT the OpenAI SDK prepends
the upstream HTTP status to the message, and NanoGPT echoes a descriptive body, so the **leading
integer of `errorMessage` is the de-facto status discriminant**. Observed verbatim:

| Case | id / condition | `errorMessage` (exact) | `willRetry` | text-mode exit |
|---|---|---|---|---|
| model unavailable | unknown/invalid id | `400 Model <id> is not supported on /v1/chat/completions.` | false | 1 |
| auth failure | bad API key | `401 Invalid session` | (n/a, fatal) | 1 |
| success | valid id | — (`PONG` on stdout) | — | 0 |

NanoGPT returns **400** (not 404) for unknown/unsupported ids, with the model id in the body.
Raw `/chat/completions` curl confirms 400 in <1s for bad ids — fast-fail, not a hang.

The json-mode terminal message carries everything structured: `stopReason`, `errorMessage`,
`provider`, `model` (the launched id — basis for the substitution check), `usage`, and the
`agent_end` event's `willRetry`.

### NanoGPT upstream error taxonomy (docs + empirical, 2026-06-29)

NanoGPT (`docs.nano-gpt.com/.../error-handling.md`) documents a structured taxonomy. Its
OpenAI-compatible body is `{error:{message,type,code,param}}`; Anthropic-style is
`{type:"error",error:{type,message,param}}`; some legacy paths use `{error:"...",status}`.

| Status | documented `type` | Pykrete disposition |
|---|---|---|
| 400 | `invalid_request_error` | **see overload below** |
| 401 | `authentication_error` / `invalid_api_key` | **fatal** (key/endpoint auth — failover can't fix) |
| 402 | insufficient balance (`{error:"Insufficient balance",requiredBalance}`) | **fatal** (out of funds — no model helps) |
| 403 | `permission_denied_error` (model/feature gated to plan) | **fail over** (another candidate may be ungated) |
| 404 | `not_found_error` + `code:"model_not_found"` | **fail over** (model-unavailable) |
| 429 | `rate_limit_error` + `Retry-After` | pi self-retries; terminal → backoff/surface |
| 408/500/503 | `server_error` / `service_unavailable` | pi self-retries; terminal → surface, **no failover** |

NanoGPT's own retry guidance: retry `408,429,500,503` (backoff, respect `Retry-After`); do NOT
retry `400,401,402,403,404,409,413`. (That governs retrying the *same* request; Pykrete failover
to a *different* candidate on 403/404 is orthogonal and correct.) This resolves two earlier
residual risks: **403 (gated) is distinguishable from 401 (bad key) by status alone** → 403
fails over, 401 is fatal; and **402 insufficient-balance** is a distinct fatal case the stub
hadn't listed.

**Empirical correction — the 400 overload (verified by raw curl):** the chat/completions endpoint
returns **400, not the documented 404**, for an unknown/unsupported id:
```json
{"error":{"message":"Model <id> is not supported on /v1/chat/completions.",
  "type":"invalid_request_error","param":"model","code":"model_not_supported",
  "details":{"endpoint":"/v1/chat/completions","requestedModel":"<id>"}}}
```
So 400 is **overloaded**: a model-unavailable signal (`code:"model_not_supported"`, model-named
message) AND, conventionally, a genuine bad-request. Status alone can't split them; the classifier
must combine: **400 + message references the model ("not supported"/"model"/the id) → fail over;
400 otherwise → fatal bad request.** Bad key empirically returns
`{"error":{"message":"Invalid session","type":"invalid_api_key","code":"invalid_api_key","status":401}}`.

**pi flattens the body.** pi's `openai-completions` catch keeps only `error.message`; the SDK
prepends the HTTP status. So via pi, Pykrete sees `"400 Model <id> is not supported…"` /
`"401 Invalid session"` — the structured `code`/`type`/`param`/`details` are **lost**. The leading
status integer + message keywords are the only signal. (If that proves too fragile, a ~5-line pi
patch to surface `error.status`/`error.code` into `diagnostics` would give a structured discriminant
— noted, not required.)

**Anthropic-style endpoint gives no classification benefit.** NanoGPT exposes
`POST https://nano-gpt.com/api/v1/messages` (Anthropic Messages; auth via `Authorization: Bearer`
or `x-api-key`; `anthropic-version` accepted-not-required), usable through pi's native
`anthropic-messages` api type. But it shares NanoGPT's model-routing validation: an unknown id
there returns the **identical** `400 / invalid_request_error / model_not_supported` (the message
even still says "…on /v1/chat/completions"). So choosing OpenAI- vs Anthropic-style transport is a
tool-call / thinking-translation decision (the R3 / flat-edit territory), **not** an error-surface
one — defer it; the validated OpenAI-completions path stands.

### Who owns retry

Two layers: (1) provider SDK `maxRetries` defaults to **0** (no SDK-level retry on the
openai-completions path); (2) the **agent-session** layer retries errors whose `errorMessage`
matches `isRetryableAssistantError` (retry.ts: `overloaded|rate.?limit|429|500|502|503|504|
service.?unavailable|…`; non-retryable: `insufficient_quota|quota exceeded|billing|usage limit|
available balance`), up to a configurable `maxRetries`, and reflects intent in the `agent_end`
`willRetry` flag. So **pi self-retries transients before returning a terminal message**;
model-unavailable 400s are non-retryable → terminal immediately with `willRetry:false`.
⇒ Pykrete should treat pi's terminal message as final and NOT double-retry transients pi already
exhausted; failover/backoff decisions key off the terminal `errorMessage` + `willRetry`.

### Recommended consumption (drives the state machine below)

Use **`--mode json`** and classify on the final assistant / `agent_end` message — it is the only
channel that (a) carries the launched `model` id, (b) separates run-level error from process
crash, (c) exposes `willRetry`, without conflating everything into one exit code. Classifier
parses the leading HTTP status + keywords from `errorMessage` (see taxonomy above):

- `400` **+ model-referenced** ("not supported"/"model"/the requested id) OR `404` → **model-unavailable
  → fail over**. (`400` without a model reference → genuine bad request → fatal.)
- `403` (model/feature gated) → **fail over** (another candidate may be ungated — distinct from 401).
- `401` (bad key / "Invalid session") or `402` ("Insufficient balance") → **fatal, no failover**.
- `429` / `408` / 5xx with `willRetry:true` → pi will retry internally; only act on the terminal
  message. Terminal transient (`willRetry:false`) → surface as run error, **no failover**.
- **Unparseable / ambiguous** → per reliability-prime, **default to fail over** (exhaust-then-error
  is observable; a missed failover silently kills a recoverable run), EXCEPT a clear `401`/`402` signal.

### Residual risks / untested

- **403 vs 401 — RESOLVED by the docs taxonomy:** NanoGPT uses `403 permission_denied_error` for
  a gated model (→ failover) and `401 authentication_error`/`invalid_api_key` for a bad key (→ fatal).
  Status alone disambiguates. (Per-model 403 still untested live — no plan-gated id to hand — but the
  documented split + default-to-failover bias make it reliability-safe.)
- **400 overload (NEW):** unknown-model returns `400`, not `404`; the classifier must gate on a
  model reference in the message, else a genuine `400` bad-request would wrongly trigger failover.
- **429 exact string** untested (no easy trigger); rely on `willRetry` + the documented
  `rate_limit_error` + `Retry-After` + retry.ts patterns.
- **String-parse fragility:** the `400 …` prefix depends on the OpenAI SDK's `APIError`
  formatting AND NanoGPT echoing status+text; pi discards NanoGPT's structured `code:"model_not_supported"`.
  Mitigation: default-to-failover bias on unparseable errors; optionally a ~5-line pi patch to
  surface `error.status`/`error.code` into diagnostics for a structured discriminant (noted, not required).
- **Startup stall:** one `pi -p` invocation hung ~2 min → SIGTERM before fast-failing on retry
  (pi does startup network ops unless `--offline`). Non-deterministic, but confirms each launch
  attempt needs a hard **per-attempt timeout** (also feeds the aggregate deadline below).

### Historical baseline — llm-bench ancestor (pi v0.70.2, 2026-04; DATED)

The precursor bench (`~/tools/llm-bench/2026-04-26/`, pi **v0.70.2** — pre provider-refactor; both
pi and NanoGPT have since moved) drove pi against NanoGPT across three transports and logged
failures. It reframes risk priorities for Spec B:

**HTTP/transport errors were NOT the dominant failure** — NanoGPT mostly "just worked" at the HTTP
layer; the reports never needed to extract status codes. The real failure mass was **semantic /
stream-level**, none of which the HTTP-status classifier above catches (they present as a
*successful-looking* `stopReason:"stop"` / exit 0, not an error):

- **Silent stops** (completion with 0 text events, stop mid-task): on the openai-compat path,
  DeepSeek-Flash **10/10**, Kimi **5/10**, GLM **2/10**; deepseek-cheaper 0/10 (clean).
- **Framing-token leaks → stream truncation:** models emit native tool-call markers
  (`<｜DSML｜tool_calls｜>`, Kimi `<|tool_call_end|>`) into `delta.content`; when a marker crosses a
  chunk boundary the parser mis-fires `finish_reason=stop` early and **swallows the tool call**
  (Flash: 64 leaks in one run). This is the R3 family — Pykrete's `flat-edit.ts` fixes the
  *edit-tool nested-schema* variant; the broader native-marker leak is upstream-translator quality.
- **Tool-call spirals / cognitive loops** (100+ calls; spin loops 140–172 calls in <2 s) and wall-time stalls.

**Per-transport (Flash / GLM / Kimi / ds-cheaper pass rates):** openai-compat `0/8/5/10`,
nanogpt-anthropic `7/7/5/10`, openrouter `10/10/9/10`. Conclusions that survive the cross-check:
- **Anthropic-compat is not a reliability win** (worse for GLM/Kimi) — **CONFIRMS** deferring it above.
- **OpenRouter clean where NanoGPT-openai-compat leaked** → the leak is **NanoGPT's translator**, not
  pi. Pykrete (NanoGPT-only by constraint) cannot fix it — the only lever is family/model selection
  (the resolver + advisory catalog), or accepting probabilistic output. **STILL-OPEN** whether
  current pi's refactored parser tolerates mid-chunk markers better.
- The **400 "model_not_supported"** HTTP shape is **STALE** vs this bench (v0.70.2 predates the
  refactor); the 2026-06-29 empirics supersede.

**Scope guard (Contract 06-05):** most of these are *verdict-gate* concerns (was the output complete/
correct?) — explicitly OUT of Pykrete, in the future orchestration project (the bench's 15-gate
engine is NOT Pykrete's job). The IN-scope slice is **transport liveness only**: a silent stop or a
truncated stream = the run died without producing the **sentinel nonce** → Pykrete's nonce-missing →
`pi --continue -p <state-aware-prompt>` resume (session-dir isolated; nonce omitted on resume to
avoid duplication — mechanics confirmed working in the bench). Spec B must NOT grow into a verdict
engine; it owns failover (model-unavailable) + nonce-driven resume (liveness), nothing semantic.

## Accepted requirements to fold in (from round-1 & round-2 reviews)

Failover state machine — must be **total and mutually exclusive** over pi outcomes:
- pi **succeeds** → return result. Emit substitution signal if launched id ≠ `intended_lead`.
- pi returns **positive model-named 4xx** (model-unavailable, exact shape TBD from pi) → fail over to next candidate.
- pi returns **per-model 403 / access-denied** (model gated to plan) → treat as model-unavailable → **fail over** (distinct from endpoint/key auth failure, which is fatal).
- pi **terminal transient** (5xx/timeout after pi exhausted its own `Retry-After` retries) → surface as run error, **no** failover.
- pi **non-model failure** (content, tool, endpoint-auth) → surface as-is, no failover.
- **Ambiguous/unclassifiable** pi error → DEFAULT decision TBD (lean: fail over, since exhausting-then-erroring is observable, whereas a missed failover silently kills a recoverable run). Confirm against pi.
- **Mixed-error exhaustion:** reserve the "family unavailable" message for the case where **all**
  candidates failed with unambiguous model-unavailable; otherwise surface the last/most-severe
  non-model error. Do not claim "family dead" if a transient was in the mix.
- Candidate list exhausted, all unambiguously model-unavailable → run error naming the family.

Budgets / safety:
- Overall **deadline / attempt budget** across the whole resolve+failover sequence (failover count
  is bounded by family-list length, but per-candidate pi retry can be long — needs an aggregate cap).

Observability / streams (RESOLVED — 2026-06-30):
- **stdout = run result only**; all Pykrete diagnostics → stderr.
- Child contract resolved: pi stdout is consumed line-by-line into the pi-events accumulator
  (never written raw to Pykrete's stdout); Pykrete reconstructs the assistant result text from the
  terminal `message_end` message and writes that to stdout via `emit`. pi does stream `message_update`
  token-delta events — live streaming to stdout is a cheap follow-up, deferred for now.
- **Failover is pre-output only**: if pi has produced any assistant text before dying, Pykrete
  surfaces the error and returns exit 1 rather than failing over (avoids double-output).
- **Exit codes (RESOLVED):** `0` = success on intended lead; `3` = success on substituted candidate;
  `4` = all candidates unambiguously model-unavailable (family appears unavailable); `1` = run error
  (fatal, transient, post-output failure, mixed exhaustion, or deadline exceeded); `2` = bad args /
  missing prompt / config error.
- **Substitution signal:** distinct exit code `3` for "succeeded, but on a substituted/downgraded
  id ≠ intended_lead", so a result-only caller (reads stdout) can detect the downgrade without
  parsing stderr prose.
- Substitution baseline = `intended_lead` (the pre-reorder `candidates[0]` from Spec A): a launched
  id ≠ `intended_lead` is a downgrade. Uniformly covers task-default, general-driven, and
  family-list-only cases.
- **Transient retry** is delegated to pi's native retry layer, pinned via `settings.json`
  (`retry.enabled=true`, `maxRetries=3`, `baseDelayMs=2000`, `provider.maxRetryDelayMs=60000`).
  Pykrete treats pi's terminal message as final and does NOT double-retry.
- **Opt-in heartbeat:** set `PYKRETE_HEARTBEAT_SECONDS=<n>` to receive periodic JSON liveness
  records on stderr: `{"pykrete":"heartbeat","candidate":"…","elapsed_s":…,"events":…,"idle_s":…}`.
  Off by default so interactive use stays quiet.

Launch transport (RESOLVED — 2026-06-30):
- **`pi -p` direct invocation chosen.** `pi-orchestrator` (supervisor / restart / multi-instance) is
  experimental and not required for the failover state machine. Pykrete owns the per-candidate launch
  loop; pi handles per-model transient retry internally. Orchestrator deferred.

## Scope guard

Per Contract 06-05, the cross-task fallback (a dead `code` pick falling to the `general` pick) is
deliberate and in-bounds: it resolves *within the caller's declared family* and never infers a
task. Documented here so it isn't mistaken for model-selection intelligence.

### Known v1 boundaries

- **Model-endpoint stalls do not trigger failover in v1.** pi emits `session`/`agent_start` (~700 ms) *before* contacting the model, which disarms the startup watchdog. A candidate whose **inference** then hangs (endpoint stuck, no tokens) is caught only by the overall timer → classified `transient` → surfaced as exit 1, **not** failed over. The `startupTimedOut → model-unavailable → failover` path therefore catches pi-process startup stalls (the `--offline`-mitigated case), not model-unavailability that manifests as a mid-inference stall. The fix is the deferred idle/no-progress watchdog (kill + classify model-unavailable when `idleMs` exceeds a cap before any output); accepted as a known boundary for v1.
