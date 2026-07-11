# Liveness/Resume De-risk Spike — Findings (pi@0.80.3)

**Status:** COMPLETE. Core assumptions (session `--continue`, nonce round-trip,
`.jsonl` session artifact, key injection, error-shape reconciliation) all hold.
**Two design changes** are required before Task 1 (see §Action-required); several
confirmations tighten later tasks.

**Runner:** pi `0.80.3` via `npx @earendil-works/pi-coding-agent@0.80.3`
(local `~/pi` checkout is `0.80.2`; the plan pins `0.80.3`).
**Models:** `gpt-4o-mini` / `gpt-4o` (tool-capable). `Meta-Llama-3-1-8B-Instruct-FP8`
is unusable with pi — see §Step 3.
**Key:** the key in `~/.pi/agent/auth.json` was 401-dead for inference; the user
supplied a working key, now in `auth.json` (original dead key backed up out-of-repo).

---

## Action-required (design changes before Task 1)

### AR-1 (HIGH) — a network outage classifies as `ambiguous` and CASCADES instead of backing off
A real connectivity failure (DNS/refused/unreachable), after pi exhausts its own
internal retries, surfaces as:
```
stopReason:"error"  errorMessage:"Connection error."   (NO leading HTTP status)
```
`parseStatus` (`/^\s*(\d{3})\b/`) does not match → `classify` falls through to
`ambiguous` (classify.ts:55). runCandidate branch 7 (plan:1408) routes
`ambiguous, no output` to **failover with no probe** ("a clean 4xx already proves
reachability"). But there was no 4xx — the server was unreachable. So during an
outage Pykrete burns through every candidate (~pi-retry time each) and exits 1,
**never entering the paused-deadline backoff the whole layer exists to provide.**
`classify` conflates two failures under `ambiguous`: (a) inconclusive-but-server-
responded (truncated stream, startup stall) and (b) network-unreachable. Branch 7's
"no probe" reasoning is only valid for (a).
- **Observed:** bad baseUrl → repeated `message_end stopReason:error
  errorMessage:"Connection error."` at 1/2/4/8s (pi's own retry), then terminal.
- **`"Connection error."` is the OpenAI SDK `APIConnectionError` message, not a pi
  string** (not found in pi's dist) — its exact wording is dependency-controlled,
  so string-matching it in classify is fragile.
- **Recommended fix (robust):** in runCandidate, **probe on `ambiguous`-no-output
  too** (branch 7), not just `transient`. `ambiguous` is by definition
  inconclusive; a cheap `/models` probe disambiguates outage vs. genuine ambiguity.
  `up` → failover as today; `down`/`throttled` → outage backoff. Keeps
  `model-unavailable` on the no-probe fast path (a real 4xx does prove reachability).
- **Alternative (localized, fragile):** map bare connection errors to `transient`
  in classify (status undefined + stopReason error + `/connection error|econnrefused
  |enotfound|etimedout|fetch failed|socket hang up/i`). Reuses branch 4, but relies
  on matching an SDK-owned string. Prefer the probe-on-ambiguous fix.
- **Affects:** Task 6 (runCandidate branch 7) and/or Task 3 (classify) + spec §5/§11.

### AR-2 (MEDIUM) — the reachability probe CANNOT detect a bad key; drop `auth` from the probe
`GET /api/v1/models?detailed=true` is **fully public**: returns `200` with a valid
key, no key, and a bogus key alike (and 30 concurrent GETs → 30×`200`, no `429`).
So the Task 2 probe can never observe `auth`, and there is no error body to parse.
- **Consequence:** the probe's contribution collapses to `up` (200) / `down`
  (timeout/5xx/network) / `throttled` (429). The `auth` state must be **removed from
  the probe's return** — bad-key detection already comes from the inference stream:
  `classify` maps `401` (leading the `errorMessage`) → `fatal` (classify.ts:43),
  verified below. The spec's 4-state probe enum should become 3-state
  (`up|down|throttled`); `auth` remains a *classify* verdict, not a *probe* state.
- **429 quantification (D6):** `/models` did not `429` under a 30-way concurrent
  burst, so the phantom-throttle risk at real probe cadence (one GET per outage
  backoff) is negligible.
- **Affects:** Task 2 (reachability enum), spec §2 signature + components table + §11.

---

## Step-by-step

### Step 1 — version & invocation ✅ (+ one operational must-fix)
`--version` → `0.80.3`. All spike flags exist: `--offline` ("Disable **startup**
network operations" — inference still hits the network), `--session-dir`,
`--continue/-c`, `-p`, `--mode json`, `--provider`, `--model`.
- **OPERATIONAL: pi hangs indefinitely unless stdin is closed.** `-p --mode json`
  with an open stdin blocked >90s emitting nothing; `</dev/null` → clean exit in ~1s.
  This is the true cause of the "~2min startup stall" folklore. **`launch.ts`
  already spawns with `stdio:["ignore","pipe","pipe"]` (stdin ignored) — correct;
  do not "fix" it.** Any manual/spike invocation must redirect `</dev/null`.
- pi emits **non-JSON lines on stdout even in `--mode json`**, e.g.
  `Warning: Model "X" not found for provider "nanogpt". Using custom model id.`
  `pi-events.push()`'s `try/catch` already drops non-JSON lines — correct.

### Step 2 — session `--continue` round-trip ✅
Run 1 "Remember BANANA… reply ok" → assistant `"ok"` (stopReason `stop`).
Run 2 `--continue` "what was the codeword?" → assistant `"BANANA"`. **Session context
survives the process boundary.**
- **On-disk artifact:** the `--session-dir` receives `<ts>_<uuid>.jsonl` (e.g.
  `2026-07-10T18-16-24-673Z_019f4d3e-….jsonl`). **`sessionReady()`'s `*.jsonl` check
  (Task 8) is valid for 0.80.3.** (`--export` also names `session.jsonl`.)
- **Envelope shape:** terminal `message_end` carries
  `{message:{role:"assistant", content:[{type:"text",text:…}], stopReason, errorMessage?, model, usage}}`.
  `turn_end` and `agent_end` mirror the same message. Persisted session `.jsonl`
  records are `{type:"message", id, parentId, timestamp, message:{…}}` (distinct
  from the `--mode json` stdout stream).

### Step 3 — nonce suffix round-trip ✅ (bounded caveat)
`buildSuffix`'s `WORK COMPLETE <nonce>` round-trips; **trim-tolerant substring match
is necessary and sufficient** (real outputs put `  \nWORK COMPLETE …` or a blank
line before the marker; `.trim()` + `includes` finds it). No padding/reformatting of
the marker text.
- **Adherence depends on model strength × task substance:**
  | model | trivial "hello" | real task |
  |---|---|---|
  | gpt-4o-mini | ✗ marker skipped (2/2) | ✓ |
  | gpt-4o | ✓ | ✓ |
  A weak model on a degenerate non-task prompt clean-stops WITHOUT the marker →
  classify `incomplete` → a resume the task didn't need. Bounded to trivial inputs
  (not Pykrete's target), and the resume budget caps the waste. Note, don't block.
- **`Meta-Llama-3-1-8B-Instruct-FP8` is unusable with pi:** it rejects tool calls
  (`400 … "This model does not support tool calls." code:tool_choice_unsupported`)
  and pi always sends tools → empty assistant content, stopReason `error`. Pick
  tool-capable models for any Pykrete candidate list.

### Step 4 — per-retry stdout + the 300s HTTP idle window ✅
- **Idle constant confirmed in 0.80.3:** `DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000`
  (`dist/core/http-dispatcher.js`), applied as undici `bodyTimeout`/`headersTimeout`.
  The **330s idle default is justified** and must stay outside this window.
- **pi emits `auto_retry_start` + a full agent/turn/message error cycle per internal
  retry**, backing off 1→2→4→8s (with `settings.json maxRetries`). So during a
  connection-error storm stdout is **not** silent — the 330s idle watchdog will not
  false-fire on pi's retries. The 300s window only bites a *connected-but-byte-silent*
  stream (server holds the connection open, sends nothing); the watchdog exists for
  exactly that case. Rationale intact.

### Step 4b — non-terminal-nonce / empty-final-turn ✅ (Task 4b sound)
Streaming order for a normal completion:
`message_start(assistant,len0) → message_update×N (CUMULATIVE text) →
message_end(terminal, FULL text incl. marker) → turn_end(terminal, FULL text)`.
- The marker appears in the late (cumulative) `message_update`s AND in the terminal
  `message_end`/`turn_end`. **The empty-terminal-after-nonempty-update pathology was
  NOT observed** — terminal blocks always carried the full final content.
- **Task 4b's `terminalText` (terminal-only accumulation) is sound and reads the
  right block.** Since `message_end`/`turn_end` carry the full content,
  `terminalText` equals the final text; `noncePresent(terminalText)` is correct and
  strictly safer than reading `text` (last-non-empty-any-turn). No regression.

### Step 5 — real error-message shapes ✅ (classify reconciliation, all predicates answered)
| case | `errorMessage` (verbatim) | `parseStatus` | `classify` |
|---|---|---|---|
| bogus model id | `400: {"message":"Model … is not supported …","code":"model_not_supported","param":"model",…}` | `400` | **model-unavailable** (`modelReferenced` fires on `model_not_supported` + "Model…is not supported") |
| bad key | `401: {"message":"Invalid session","type":"invalid_api_key","code":"invalid_api_key","status":401}` | `401` | **fatal** (exit 1, never 4) |
| network down | `Connection error.` | *undefined* | ambiguous → **see AR-1** |
- **Status leads the string** (commit `62fad94f` format `"<status>: <body-json>"`) —
  `parseStatus`'s `/^\s*(\d{3})\b/` matches. ✓
- **`modelReferenced` fires** for model-unavailable (JSON body, not prose — the model
  id AND `model_not_supported` are present). ✓ Note it is **HTTP 400**, not 404.
- **401 appears only in the inference `errorMessage`, never in the (public) probe** —
  reinforces AR-2. classify's `401→fatal` (classify.ts:43) is the auth path.

### Step 6 — probe endpoint ✅ → see AR-2
`/models` is public (200 regardless of key) and not readily rate-limited.

### Key-injection integration ✅ (earlier "env ignored" scare was a FALSE ALARM)
Pykrete's real key path (`launch.ts` + `agentdir.ts`): write a temp agent dir with
`models.json` `providers.nanogpt.apiKey:"$NANOGPT_API_KEY"`, set
`PI_CODING_AGENT_DIR=<dir>` and `NANOGPT_API_KEY=<key>` in the child env.
- **Verified:** with a deliberately-bogus `~/.pi/agent/auth.json` but a good
  `NANOGPT_API_KEY` env + the Pykrete agent dir, inference **succeeded**. So pi
  0.80.3 respects `PI_CODING_AGENT_DIR`, reads its `models.json`, **expands
  `$NANOGPT_API_KEY` from the env, and that overrides `auth.json`.** Pykrete's key
  injection works. (A mid-spike test that set the env key WITHOUT a Pykrete agent dir
  showed pi using `auth.json` — that is the default-dir path, not Pykrete's; the
  agent-dir `$`-ref is what threads the env key through.)

---

## Housekeeping
- `~/.pi/agent/auth.json` now holds the user-supplied working key (original 401-dead
  key backed up outside the repo). Decide whether to keep it or restore the original.
- Temp agent/session dirs cleaned.
