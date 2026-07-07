# Pykrete Liveness & Resume — Design

**Date:** 2026-07-07
**Status:** Approved (brainstorming), pending implementation plan
**Builds on:** `2026-06-29-launcher-failover-design.md` (Spec B, merged). This spec is the
**transport-liveness** slice deferred to a follow-up branch in `docs/BACKLOG.md`.

**Goal:** Detect and recover from the two liveness failure modes that Spec B's failover machine
leaves as false success or futile cascade — a clean-stop-but-incomplete run (silent stop, S1), and a
stuck/silent stream (mid-inference stall or network/provider outage) — without Pykrete ever
inspecting task *content*.

---

## Contract 06-05 scope guard

Binding constraint: **Pykrete does NOT infer, decompose, plan, or verdict-gate tasks.** This spec is
**transport liveness only**:

- **IN:** (1) sentinel-nonce liveness check → `pi --continue` resume of the **same model**; (2) idle
  watchdog → detect a stuck stream → kill → route; (3) NanoGPT reachability probe → distinguish a
  provider/network outage from a model failure, and wait it out instead of cascading.
- **OUT (forbidden):** every verdict gate from the April bench — file-count, spec-paths-missing,
  empty-diff, test-failure. The nonce is an **opaque liveness marker**, not content inspection. The
  resume prompt carries **zero** worktree state (the bench's `RESUME_TEMPLATE` file/diff/test fields
  are deliberately dropped — see §7).

Divergence from the bench: the ancestor harness (`.research/llm-bench-ancestor-2026-04-26/`) coupled
the nonce to a 13-gate verdict stack. Per the 2026-06-05 scope addendum (`DECISION.md`), Pykrete
keeps **only** the sentinel-nonce liveness signal; the gate stack belongs to the future orchestration
project.

**Interpretation pin (settles the one real tension):** the nonce elicits the model's *own*
self-declaration of completion, and Pykrete gates resume on the presence of an opaque, content-free
token (`crypto.randomBytes`). This is **NOT** verdict-gating under Contract 06-05: Pykrete never
*computes*, inspects, or judges task content — it reads a token's presence and a transport signal
(clean terminal stop). "Must not verdict-gate" is read as "must not compute a verdict," which holds.
Eliciting a yes/no liveness token is the minimum viable signal for the S1 failure mode (a clean
`finish_reason=stop` on an unfinished task), which pi cannot surface on its own.

## pi version pin & drift note (de-risk)

**Validated target: `pi@0.80.3`** (npm `@earendil-works/pi-coding-agent`, `latest` as of 2026-06-30).
pi releases fast — ~28 npm releases in the ~54 days to 2026-06-30 (~1 per 2 days, bursty). Pykrete
therefore **builds and validates against a pinned release, not `main`** (which was 54 commits past
0.80.3 and ungated at spec time). Bumping the pin is a deliberate act that **re-runs the Task 0
spike** (§11). Documented pin only — no runtime version assertion (trust the environment to install
0.80.3).

The three drifting changes that touch Pykrete **all first shipped in `v0.80.3`**, so pinning does not
avoid them — it fixes the shape we validate against:
- `62fad94f` — provider errors now surface as **`"<status>: <body-json>"`** via
  `normalizeProviderError`/`formatProviderError` (was the opaque SDK `error.message`). This is the
  string `classify.ts` parses (see §4 / §11 re-validation).
- `2117b61c` — undici mid-stream client errors handled (feeds the idle-threshold / self-retry claims).
- `e547bb9f` — session state refreshed before next turn (touches the `--continue` resume path).

pi has also changed since the ancestor harness. Commit `98ffad04` makes `openai-completions` **throw
`"Stream ended without finish_reason"`**, and `agent-session.ts`'s retryable-error regex matches
`ended without` → pi now **auto-retries internally** on a truncated stream. Consequences:

- The **truncated-stream** class (no terminal event) is now partly self-healed inside pi; Pykrete's
  existing terminal-only `stopReason` latch (→ ambiguous → failover) remains a backstop for when pi's
  own retries also exhaust. No conflict.
- The **S1 class — a clean `finish_reason=stop` with the task incomplete — still escapes** pi (it has
  no task-complete concept). That is precisely what the nonce catches. #1 is still needed.

Because pi's session/flag contract may also have drifted, **the first implementation task is a live
de-risk spike** (see §11) that verifies `--session-dir` + `--continue` + nonce round-trip against the
installed pi before any production code is built.

---

## Failure-mode → routing matrix (authoritative)

| # | Failure mode | Detected by | Route |
|---|---|---|---|
| 1 | Clean terminal stop, **nonce present** | nonce gate | success → strip sentinel, emit, exit `0`/`3` |
| 2 | Clean terminal stop, **nonce missing**, output present | nonce gate | **resume same model** (`--continue`), bounded by budget |
| 3 | Idle stall, **output present** | idle watchdog | **resume same model** (unified with #2) |
| 4 | Idle stall, **no output yet** | idle watchdog | kill → **ambiguous → failover** (all-stall aggregates to exit `1`, never `4`) |
| 5 | Resume budget exhausted, still incomplete | runCandidate | emit partial, **exit `1`** (no failover — pre-output-only) |
| 6 | **NanoGPT unreachable or throttled** (idle-kill or terminal transient — incl. **post-output** transient, D4 — + probe=`down` or `throttled`/429) | reachability probe | **back off + wait** (deadline paused), retry same candidate on return; give up at 2^10 → exit `1`. A flapping network is bounded by `MAX_OUTAGE_RETRIES=10`/candidate. |
| 7 | **`ambiguous` verdict** (connection error / truncated stream / startup stall — anything classify cannot pin). A network outage lands here: it surfaces as `errorMessage:"Connection error."` with **no HTTP status**, so classify cannot tell it from a genuinely-inconclusive stream (spike AR-1). | reachability probe | **probe first**: `down`/`throttled` → row 6 (wait + retry same candidate); `up` → genuine ambiguity → failover (no output) / exit `1` (post-output). |
| 8 | Truncated stream (no terminal event) | existing latch → `ambiguous` | sub-case of row 7: probed, then failover on `probe=up` (pi self-retries first) |
| 9 | Clean 4xx / 403-gated / **bad key (401)** / fatal / genuine transient (probe=`up`) | classify.ts | **unchanged from Spec B.** A bad key is a classify `fatal` (inference `401`), **not** a probe state — spike AR-2 found `/models` is public, so the probe can never see auth. |

**Unifying principle:** *output present + incomplete → resume the same model; no output + stuck →
fail over; provider/network unreachable → wait it out (never cascade, never exit 4); a clean 4xx
proves the API is up, so it stays genuine model-unavailability. An `ambiguous` verdict is the one
that might secretly be an outage (no HTTP status), so it is probed before it is trusted (AR-1).*

**The rows are layered, not mutually exclusive — precedence resolves overlap** (see §5 for the
full flow):

1. **Reachability preempts (rows 6, 7).** Any **idle-kill, terminal-transient, or `ambiguous`
   verdict** is probed *first*. `probe=down`/`throttled` → row 6 (back off + wait, retry same
   candidate) preempts rows 3, 4, and the plain `ambiguous`→failover. Only `probe=up` falls through
   to nonce/output classification (row 7's `up` case → failover/exit 1). A **clean terminal stop**
   (rows 1, 2) or a **clean provider response** (row 9: 4xx / 401 / fatal — the server answered)
   proves the API was reachable, so those are **not** probed on entry; only a resume *relaunch* is
   probe-gated (a network drop between attempts re-triggers row 6).
2. **Rows 2 and 3 are one action, two detectors.** Both route to the *same* bounded `--continue`
   resume of the same model — nonce gate (row 2) and idle watchdog + output present (row 3) are
   just two ways to detect "output present but incomplete". "(unified with #2)" marks this.
3. **Row 4 is implicitly `probe=up`** (the `probe=down` case is row 6).

---

## Components

| File | Change | Responsibility |
|---|---|---|
| `src/nonce.ts` | **new** | `mintNonce()`, `buildSuffix(nonce)`, `noncePresent(finalText, nonce)`, `stripSentinel(text, nonce)` |
| `src/reachability.ts` | **new** | `probeNanoGpt(deps) → "up" \| "down" \| "throttled"` — a single `/models` GET (no `auth`: `/models` is public, spike AR-2) |
| `src/runCandidate.ts` | **new** | One candidate's full lifecycle: session dir, nonce injection, launch, nonce/idle gate, bounded `--continue` resume loop, reachability-gated backoff. Returns a `CandidateResult` |
| `src/launch.ts` | modify | Idle watchdog; `idledOut` + `sawOutput` flags on `AttemptOutcome`; `--session-dir` support; `--continue` + resume-prompt opts; drop hard-coded `--no-session` |
| `src/pi-events.ts` | modify | Expose `terminalText` (terminal-block text) so the nonce gate reads the genuinely-final block (review fix E) |
| `src/classify.ts` | modify | `stop`/`length` is `success` only if the nonce is present (or nonce disabled); otherwise new verdict `incomplete` |
| `src/failover.ts` | modify | Call `runCandidate` instead of `launchAttempt`; handle the `incomplete` terminal (emit partial, exit `1`, no failover); accumulate `pausedMs` into the deadline math |
| `src/config.ts` | modify | New `[liveness]` config block with defaults |
| `bin/pykrete.ts` | modify | Per-run session-dir temp lifecycle + cleanup; thread liveness config through |

### Design principle
Each file keeps one responsibility. `launch.ts` stays **single-process** (spawn + accumulate + kill).
`runCandidate.ts` owns **one candidate's** recovery policy (resume loop, backoff). `failover.ts` stays
the **cross-model** loop and only ever sees reachability-`up` verdicts — all outage handling is
contained in `runCandidate`. `classify.ts` stays a pure outcome→verdict function.

---

## §1 — nonce.ts

```
mintNonce(): string                       // crypto.randomBytes(8).toString("hex")
buildSuffix(nonce): string                // fenced completion-sentinel instruction block
noncePresent(finalText: string, nonce): boolean   // final text block contains "WORK COMPLETE <nonce>"
stripSentinel(text: string, nonce): string        // remove the sentinel line before emit
```

- **Nonce source:** `crypto.randomBytes` (never `Math.random`). 8 bytes → 16 hex chars, matching the
  bench's `secrets.token_hex(8)`.
- **Suffix** (appended to the caller's prompt on the **first** attempt only): a fenced block
  instructing the model to end its final message with the exact phrase `WORK COMPLETE <nonce>`, and
  stating **this is a liveness marker and must never be written to any file** (guards against the
  bench's H2 chain where models echoed injected text into deliverables —
  `.research/bench-run1-forensics.md` §3).
- **Presence** = the **final** assistant text block contains the exact `WORK COMPLETE <nonce>`
  (bench gate-9 semantics — final block, not anywhere in the transcript). This is a **substring
  match, whitespace-tolerant** (trim before matching) — robust to pi 0.80.3's configurable
  assistant-output padding (`6564d947`); an exact-equals check would be brittle to it.
  **Enforcement (review fix E):** "final block" is not a property `noncePresent` can provide alone — it
  is a property of the accumulator. `pi-events.ts` exposes `terminalText` (the text of the terminal
  `message_end`/`turn_end` block) separately from `text` (last non-empty turn, used for emission), and
  `runCandidate` gates the nonce on `terminalText`. So a marker left in a non-terminal `message_update`
  followed by an empty terminal turn does **not** read as success (it drives a resume instead). This
  depends on the spike (§11 Step 4b) confirming pi's terminal event carries the final answer text.
- **Strip:** the emitted stdout has the sentinel line removed; the caller never sees the marker.

## §2 — reachability.ts

```
probeNanoGpt({ fetchImpl, apiKey, timeoutMs }): Promise<"up" | "down" | "throttled">
```

- Reuses the existing `MODELS_URL` (`catalog.ts:18`, `https://nano-gpt.com/api/v1/models`) +
  `Authorization: Bearer <apiKey>` + injectable `fetchImpl`. No new secrets or HTTP config.
- Adds a short `AbortController` timeout (default 4 s) so a hung probe cannot itself stall.
- Result mapping (**reachability only** — no `auth`):
  - `429` → `"throttled"` — reachable but rate-limited. **Never a hard outage (never exit 4)**, but
    per the D6 decision it still enters the exponential backoff (rate-limiting warrants backing off),
    via the same ladder as `down` with distinct diagnostics.
  - `200` → `"up"`.
  - any other status (`4xx`/`5xx`), timeout, connection/DNS error (fetch rejects) → `"down"`
    (could not confirm reachability).
- **No `auth` state (spike AR-2):** `/models` is a **public** endpoint — it returned `200` with a
  valid key, no key, and a bogus key alike (and no `429` under a 30-way concurrent burst). The probe
  therefore cannot detect a bad key, and there is no error body to parse. Bad-key detection lives in
  `classify` (inference `401 → fatal`); the probe reports reachability only.
- **Limitation (accepted):** `/models` reachability is a *proxy* for `/chat/completions`
  reachability; the metadata gateway being up does not 100% guarantee inference is up. A perfect
  probe would consume inference credits. This is the cheap, already-plumbed approximation.

## §3 — launch.ts (idle watchdog + sessions)

**Idle watchdog:**
- A timer that fires when `now − lastEventAt > idleTimeoutMs`. `lastEventAt` already exists and resets
  on every stdout line.
- **Armed only after the first event** (`agent_start`, ~700 ms in). Before the first event the
  existing **startup watchdog** owns the window; the idle watchdog covers the post-`agent_start`,
  possibly-mid-inference window that the startup watchdog disarmed (the Spec B "known v1 boundary").
- On fire: reuse the existing `escalate()` (SIGTERM → SIGKILL → force-resolve). Set `idledOut = true`.
- **Threshold must sit OUTSIDE pi's HTTP idle window (D1, corrected rationale).** The real silent window
  is not the agent-session retry backoff (2/4/8 s, which emits visible `auto_retry_start` stdout events
  that reset `lastEventAt`) but pi's undici `bodyTimeout`/`headersTimeout`:
  `DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000` (`packages/coding-agent/src/core/http-dispatcher.ts:3`). A
  single stream can be silent on stdout ~300 s before pi aborts and self-retries. So the default is
  **`idleTimeoutMs = 330_000` (330 s)**, configurable — pi's own abort/self-heal fires first, and the
  watchdog only reclaims a stream pi has genuinely abandoned. A 120 s default (the earlier draft) would
  false-kill slow-but-alive streams and undercut pi's self-retry — a reliability regression. The spike
  (§11 Step 4) confirms the 300 s window empirically before this is trusted.

**New `AttemptOutcome` field:**
- `idledOut: boolean` — the idle watchdog fired.

The pre-output vs post-output branch reuses the accumulator's existing `outcome.sawAssistantOutput`
(already true when any assistant text **or** tool activity was seen) — no separate launch-level flag.

**Sessions:**
- New option `sessionDir: string` → pass `--session-dir <sessionDir>` and **drop `--no-session`**.
  Pykrete always allocates a per-run session dir now (needed for resume).
- New options `continueSession?: boolean` (adds `--continue`) and a prompt override so a resume
  attempt sends the resume prompt instead of the original prompt + suffix.

## §4 — classify.ts (nonce-aware success)

Add `incomplete` to the `Verdict` union:

```
| { kind: "incomplete"; message: string }
```

`classify` gains an optional `noncePresent?: boolean` input (undefined ⇒ nonce disabled ⇒ Spec B
behaviour). New rule, replacing the current unconditional `stop`/`length → success`:

- `stop` / `length` **and** (`noncePresent === true` **or** nonce disabled) → `success`.
- `stop` / `length` **and** `noncePresent === false` → `incomplete` (drives resume).

Everything else in `classify` is unchanged from Spec B (401/402 fatal; 404 model-unavailable;
403 model-referenced split; 400 model-referenced split; 408/429/5xx transient; startup/overall
timeouts; truncated-stream → ambiguous) — **subject to the Task 0 error-shape re-validation**: pi
0.80.3's new `"<status>: <body-json>"` error format (commit `62fad94f`) may require adjusting
`parseStatus` and/or `modelReferenced`. `parseStatus`'s anchored `/^\s*(\d{3})\b/` survives the
no-prefix `"403: …"` form (the colon is a word boundary), but `modelReferenced` now matches a JSON
body rather than the old prose; the spike confirms or corrects this before build.

## §5 — runCandidate.ts (per-candidate lifecycle)

```
runCandidate(candidate, ctx, deps): Promise<CandidateResult>

CandidateResult =
  | { kind: "success"; text: string }          // nonce seen (post-resume ok) → emit, exit 0/3
  | { kind: "incomplete"; text: string }        // budget exhausted, output present → emit partial, exit 1
  | { kind: "failover"; verdict: Verdict }       // stuck-no-output / model-unavailable / ambiguous
  | { kind: "fatal"; message: string }           // auth-fail / classify fatal → exit 1
  | { kind: "transient"; message: string }       // genuine transient, probe=up → exit 1
  & { pausedMs: number }                          // time spent in reachability backoff (deadline pause)
```

Flow for one candidate:

1. `nonce = mintNonce()`; create/confirm the per-run session dir; launch with `prompt + buildSuffix`.
2. **Gate the outcome:**
   - **classify `success`** (nonce present) → return `success` (text = `stripSentinel(...)`).
   - **classify `incomplete`** (clean stop, nonce missing, output present) → **resume path** (step 3).
   - **`idledOut` + `sawAssistantOutput`** (post-output stall) → **reachability + resume path**
     (step 3, gated).
   - **`idledOut` + !`sawAssistantOutput`** (pre-output stall) → **reachability gate** (step 4);
     if `up`, return `failover` (ambiguous).
   - **classify `transient`** → **reachability gate** (step 4); if `up`, return `transient`.
   - **classify `ambiguous`** → **reachability gate** (step 4; spike AR-1): a network outage surfaces
     as `ambiguous` (`"Connection error."`, no HTTP status), indistinguishable from a truncated stream.
     `down`/`throttled` → wait + retry the same candidate; `up` → genuine ambiguity → `failover` (no
     output) / `fatal` (post-output). This gate sits ahead of both the post-output-death and the
     no-output-failover branches, so an outage is waited out in either output state.
   - **classify `model-unavailable` / `fatal`** (clean provider responses, API proven up) →
     return `failover` / `fatal` accordingly — **no probe** (a real 4xx/401 already proves reachability).
3. **Resume path** (bounded by `resumeAttempts`, default `1`):
   - Before each resume, run the **reachability gate** (step 4). If it forces a wait, resume after the
     network returns.
   - Relaunch `pi --session-dir <same> --continue -p <resumePrompt>` (nonce **not** regenerated).
   - Re-gate: nonce present → `success`; still incomplete and budget left → loop; budget exhausted →
     return `incomplete` (emit partial, exit 1, **no failover**).
4. **Reachability gate** (the shared outage handler). Returns one of three results (no `fatal`/auth —
   the probe hits the public `/models`, spike AR-2, so it can never see a bad key; auth is a `classify`
   `fatal` reached before any gate):
   - `proceed` — `probe = up` on the first try: no outage, caller routes per its verdict.
   - `recovered` — `probe = down` **or** `throttled` (429, D6), then the **backoff-wait loop**
     (`delay = 1s`; while `delay ≤ 1024s`: `sleep(delay)`; re-`probe`; `up` → `recovered`;
     else `delay *= 2`) came back up. Caller **retries the same candidate** (resume if
     `sawAssistantOutput` **and** a resumable session exists, else fresh launch) — this does **not**
     consume a resume attempt, and is bounded by `MAX_OUTAGE_RETRIES = 10`/candidate so a flapping
     network cannot loop forever. **Clarification (G):** "does not consume a resume attempt" applies to
     this outage-retry path. A `--continue` **resume** issued from the incomplete/idle-resume path
     (`resumeOrTerminal`) that merely *waited out* an outage on its pre-relaunch gate **does** consume
     one — it is a genuine resume, not an outage-retry. And a post-output outage-retry that finds **no
     resumable session** does not blindly `--continue`; it becomes the unified partial terminal (B/D).
   - `giveup` — the loop exhausted past 2^10 → return `transient` ("gave up after backoff") → exit 1.
   All slept time accumulates into `pausedMs` (the deadline is paused, never burned, by an outage).
   Per **D4**, a **post-output transient** (a 429/5xx after the model already emitted output) routes
   through this gate BEFORE the post-output-death branch, so a real outage is waited out rather than
   producing an immediate exit 1; only a post-output *hard* failure (clean 4xx / fatal, API proven up)
   exits 1.

**Backoff constants:** base `1_000 ms`, factor `2`, cap `1_024_000 ms` (2^10 s). The ladder is
1,2,4,…,1024 s (11 probes, ~2047 s per continuous outage). Injected `sleep(ms)` and `now()` deps keep
tests fast and deterministic. Per the approved decision, **outage waits pause the overall deadline**
(see §6); the 2^10 cap bounds a single *continuous* outage — a flapping network spawns a fresh ladder
per down-spell (accepted).

## §6 — failover.ts

- Call `runCandidate(candidate, ...)` per candidate instead of `launchAttempt` + inline `classify`.
- Map `CandidateResult`:
  - `success` → `emit(text)`; exit `0` if `candidate === intendedLead` else `3` (+ substitution
    warning). Unchanged transparent contract — **a resumed success is still `0`/`3`**; "resumed" is a
    stderr diagnostic only.
  - `incomplete` → `emit(text)` (partial); `warn(...)`; exit `1`. No failover.
  - `fatal` / `transient` → `warn(...)`; exit `1`. No failover.
  - `failover` → advance to the next candidate (existing ambiguous/model-unavailable aggregation:
    all-clean-model-unavailable → exit `4`; any ambiguous/stall in the mix → exit `1`).
- **Deadline pause:** track `totalPausedMs`; the remaining-deadline computation becomes
  `deadlineMs − (now() − start − totalPausedMs)`. Each `CandidateResult.pausedMs` is added to
  `totalPausedMs` so reachability backoff never burns the deadline.

## §7 — Resume prompt (Contract-06-05 stripped)

The resume prompt is **status-only** and carries no worktree inspection (the bench's file/diff/
missing-paths/test-failure fields are all dropped):

```
Your previous session stopped, but the task may not be complete. This block is
status only — do NOT write it to any file. If the task is incomplete, continue.
If it is genuinely complete, end your final message with exactly:
WORK COMPLETE <nonce>
and then stop.
```

- Nonce reused (it lives in session history from the first attempt), not regenerated.
- The "do NOT write it to any file" fence is the H2 vendor-injection guard.

---

## Configuration

New `[liveness]` block in `pykrete.toml`, with defaults chosen for reliability:

| Key | Default | Meaning |
|---|---|---|
| `nonce_enabled` | `true` | Inject the sentinel suffix + run the nonce gate + enable resume. `false` → identical to Spec B (no injection, `stop`/`length` = success, no resume). |
| `idle_timeout_seconds` | `330` | Idle-watchdog threshold. Must sit OUTSIDE pi's 300 s HTTP idle window (D1) so pi self-heals first. A value ≤ 300 is **accepted with a loud warning** (Q3) — it may false-kill a slow-but-alive stream unless the operator has also lowered pi's own `httpIdleTimeout`. |
| `resume_attempts` | `1` | Bounded `--continue` resumes per candidate before giving up (exit 1). |

Backoff ladder (base 1 s → cap 2^10 s) and probe timeout (4 s) are internal constants for v1, not
config knobs (add later if a caller needs them). The existing overall/startup timeouts, deadline, and
`PYKRETE_HEARTBEAT_SECONDS` are unchanged.

---

## Exit codes — contract unchanged

No new codes. Clarifications folded into Spec B's contract:

| Code | Meaning (this spec's additions in **bold**) |
|---|---|
| `0` | Success on the intended lead — **including after a `--continue` resume (transparent)**. |
| `3` | Success on a substituted candidate — **including after resume**. |
| `4` | All candidates **cleanly** model-unavailable. A pre-output stall (ambiguous) or an outage (probe=down) in the mix **never** produces `4`. |
| `1` | Fatal / genuine transient / post-output death / mixed exhaustion / deadline / **incomplete-after-resume** / **outage give-up (2^10)** / **bad API key (inference 401 → classify fatal, AR-2)**. |
| `2` | Bad args / missing prompt / config error. |

---

## Error handling / edge cases

- **pi died before producing output and before creating a session dir** (instant crash,
  `sawAssistantOutput:false`) → cannot `--continue` → classify `ambiguous` → `failover` — reached via
  the loop's final branch **without consulting `sessionReady()`** (that gate only runs on post-output
  resume paths).
- **pi produced output but left no resumable session** (death/outage after emitting, no `.jsonl`) →
  every post-output resume path checks `sessionReady()` first — hardened (D7) to require a `.jsonl`
  transcript in the dir (not merely that Pykrete's own `mkdirSync` left it non-empty) — and a false
  result routes to the unified partial terminal (emit + banner + exit 1), **never failover** (Fix C).
- **`--continue` cwd invariant (D7):** pi's `--continue` filters candidate sessions by exact resolved-cwd
  equality; if the resume ran from a different cwd it would silently start fresh (empty context, no
  error). Pykrete spawns pi from one stable cwd across a candidate's attempts, satisfying this; a future
  change that alters cwd between attempts would break resume silently. Spike Step 2 asserts context
  actually survives.
- **Model ignores the suffix and never emits the nonce** → resumes to `resume_attempts`, then exit 1
  with partial. Mitigated by the small default budget (`1`); a known cost documented here.
- **Session dir** is a per-run temp dir, created in `bin/pykrete.ts` and removed in `finally`
  (mirrors the existing `agentDir` lifecycle).
- **Nonce disabled** → byte-for-byte Spec B on the success path; the idle watchdog and reachability gate
  still operate (independent of the nonce). A post-output stall with the nonce disabled cannot be
  resume-gated, so it takes the **unified partial terminal** (see below): emit the partial + loud banner
  + exit 1. (This supersedes the earlier D2 "no-emit fatal" choice — the loud banner is what makes
  emitting the partial safe.)

- **Unified "produced-output-but-cannot-resume" terminal (review pass B/C/D + Q1).** Whenever a candidate
  produced assistant output but cannot cleanly complete or resume — resume budget exhausted, no resumable
  session on disk, nonce disabled, or an outage recovered but the run can't be continued — Pykrete emits
  the partial text to **stdout**, prints a loud `WARNING: PARTIAL OUTPUT (<reason>) — TREAT AS INCOMPLETE
  / REQUIRES VERIFICATION` banner to **stderr**, and exits **1**. It never fails over to another model
  (the first already produced output/side-effects) and never re-runs the task fresh. The banner is on
  stderr, not wrapping stdout, so stdout stays the machine-readable channel; the non-zero exit is the
  authoritative "do not trust" signal. A post-output *hard* failure (clean 4xx / fatal — API proven up)
  is distinct: it stays `fatal` (exit 1, no emit).
- **Provider-side outage with local network up** → probe=`up` → normal routing (transient → exit 1,
  or per-candidate model-unavailable). Distinguishing a NanoGPT-wide outage from per-model
  unavailability without a NanoGPT health signal is out of scope; `/models` is the proxy.
- **Idle threshold too low** would kill legitimate pi retries / slow streams — the 330 s default (outside
  pi's 300 s HTTP idle window, D1) plus the spike's measurement of pi's per-retry stdout behaviour guard this.

---

## §11 — Testing

TDD per unit. `node:test` + `node:assert/strict`; TS via `node --experimental-strip-types`; strict
`tsc --noEmit`. All timing/network/randomness is **injected** (sleep, now, fetchImpl, connect) so
tests are fast and deterministic.

- **nonce.ts:** mint format (16 hex); `noncePresent` true only when the **final** block contains the
  phrase (false when it appears mid-transcript but not last); `stripSentinel` removes exactly the
  marker line.
- **reachability.ts:** injected `fetchImpl` → `200`→`up`, `429`→`throttled`,
  `401`/`403`/`500`/reject/timeout→`down` (no `auth` — spike AR-2); AbortController timeout path.
- **launch.ts:** idle watchdog fires → `idledOut` set, `escalate()` invoked; pre-output idle
  (`agent_start` then hang, no output) → `idledOut && !sawAssistantOutput`; post-output idle (one
  line then hang) → `idledOut && sawAssistantOutput`; session flags asserted on the spawned argv.
- **classify.ts:** `stop` + `noncePresent:false` → `incomplete`; `stop` + `noncePresent:true` →
  `success`; `noncePresent:undefined` (disabled) → `success` on `stop` (Spec B parity).
- **runCandidate.ts:** nonce present first try → `success`; nonce missing → resume → `success` on the
  2nd attempt; resume budget exhausted → `incomplete` with partial text; pre-output stall + probe=up
  → `failover`; post-output session-missing → `incomplete` (partial + banner, **never failover**);
  bad key (inference `401`) → `fatal` with **no probe** (AR-2); `ambiguous` connection-error +
  probe=`down`-then-`up` → backs off and retries the **same** candidate (AR-1), `ambiguous` +
  probe=`up` → `failover`; probe=`down`-then-`up` →
  retries the **same** candidate, **no failover consumed**, `pausedMs` > 0; probe=`down` to cap →
  `transient` (exit 1); assert the backoff ladder (1,2,4,…,1024) via the injected sleep.
- **failover.ts:** `incomplete` terminal → exit 1 + partial emitted, no next candidate tried; resumed
  `success` → exit `0`/`3` (transparent); `pausedMs` excluded from the deadline (a candidate that
  waited out an outage still gets its full remaining budget).
- **fake-pi.mjs** new scenarios: `idle` (agent_start, one line, then hang), `silentstop` (emits text
  + `stop`, **no** nonce), `resumeok` (emits the nonce only when invoked with `--continue`; requires
  the fixture to detect the `--continue` flag / session state).

### De-risk spike (Task 0 of the plan — before any production code)

A throwaway live run against **`pi@0.80.3`** confirming: (a) pi accepts `--session-dir` +
`--continue`; (b) session context survives across the process boundary; (c) the nonce suffix reliably
produces `WORK COMPLETE <nonce>` in the final text block; (d) whether pi emits any stdout per internal
retry attempt (informs the idle threshold); (e) **the real NanoGPT error-message shape** — capture an
actual model-unavailable error (e.g. a bogus model id) and a 401/403, then re-validate
`classify.parseStatus` (does the status still lead the new `"<status>: <body-json>"` format?) and
`classify.modelReferenced` (does it still match against a JSON body rather than the old prose?). Since
`62fad94f` shipped in 0.80.3, this reconciliation is **required**, not contingent — and it guards the
already-merged Spec B classify as well as this spec. **Spike outcome** (see
`2026-07-07-liveness-resume-spike-findings.md`): both confirmed — `400: {…model_not_supported…}` →
model-unavailable, `401: {…invalid_api_key…}` → fatal; status leads the string. The spike also drove
**AR-1** (a network outage classifies as `ambiguous` → must be probed, not failed over) and **AR-2**
(`/models` is public → the probe cannot see auth; `auth` dropped from the enum).
(f) **output padding** — confirm whether `6564d947`/`9be55bc7` pad `--mode json` message *content*
(vs interactive-TUI rendering only); if content, verify the reconstructed final-text nonce match and
`stripSentinel` survive the padding (the whitespace-tolerant match in §1 should already cover it).
If any assumption fails, adjust before investing in the resume machinery.

---

## Out of scope (recorded, not built)

- Verdict gates (file-count, spec-paths, empty-diff, test-failure) — future orchestration project.
- Live token streaming of `message_update` deltas to stdout (separate backlog item).
- Process-group / detached-grandchild kill (separate backlog item).
- Making the backoff ladder / probe timeout configurable.
- Distinguishing NanoGPT-wide provider outages from per-model unavailability.
