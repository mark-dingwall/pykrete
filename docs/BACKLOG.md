# Pykrete backlog

Nothing here is blocking; recorded so future reviews don't re-discover it cold. Items came in
from the Spec B failover review (2026-07-01) and later passes — each entry dates its own source.

## Transport liveness
Sentinel-nonce → `pi --continue` resume and the idle / no-progress watchdog were both delivered on
the liveness branch and **merged 2026-07-11** (`runCandidate.ts` resume loop; `launch.ts` idle
timer). Design: `docs/superpowers/specs/2026-06-29-launcher-failover-design.md` l.218–222.

Still outstanding from that design:
- **Live streaming** of `message_update` token deltas to stdout (design doc l.247). Pykrete buffers
  the run and prints only the reconstructed terminal text, so a long run shows nothing until it ends.

## Setup / operability
(2026-07-21, found while bringing a clean host up to a working state.)
- **`pi` is an undeclared runtime dependency.** `launch.ts` resolves a bare `"pi"` on PATH (or
  `PYKRETE_PI_BIN`); nothing in `package.json` declares or version-checks it. The four pi contracts
  are verified against **0.80.10** only — a host with an older or newer pi fails at spawn time or,
  worse, silently drifts off-contract. Consider a startup version probe.

## Reliability / robustness
- **Process-group / detached grandchild kill.** The hang backstop force-resolves and unrefs, so the
  Pykrete process exits, but a grandchild that inherited the stdout pipe is abandoned (left running).
  Spawn `detached` + `process.kill(-pid)` on escalation to reap the whole tree.
- **`createAgentDir` throw → clean exit.** A write failure now self-cleans then rethrows, which
  escapes `main()` as an unhandled rejection (Node prints a stack trace, exits 1). Exit code is
  contract-correct; catch it in bin for a clean `pykrete: …` message instead.
- **Cap stderr accumulation.** `launch.ts` grows `stderr` unbounded; keep only the last N KB.
- **Enforce a floor on `idle_timeout_seconds`.** `config.ts` validates only "positive integer", so a
  configured `90` is accepted even though the D1 invariant requires the idle watchdog to sit outside
  pi's 300s undici HTTP-idle window (hence the 330s default). Below that floor Pykrete kills a healthy
  pi mid-request — the exact failure the watchdog exists to prevent. Reject `< 330`, or warn loudly.
  (Raised as MEDIUM in the 2026-07-10 liveness plan red-team; the only finding from that pass not
  applied before merge.)

## Tests / observability
- **bin exit-1 e2e** (fatal/transient run-error) case — the matrix covers 0/2/3/4 but not 1.
- **Negative-space stdout assertion** — `assert.doesNotMatch(stdout, /pykrete:/)` so diagnostics
  can't regress onto stdout.
- classify: assert the `.message` field on fatal/transient verdicts; `parseStatus` anchor guard test;
  unknown-`stopReason` coverage.
- **`agentdir.test.ts` guards check key NAMES, not pi's schema constraints.** The transcribed key
  sets catch an unknown/removed key, but not TypeBox value constraints — a mutation setting
  `baseUrl: ""` still passed a test named "...schema accept". Either narrow the naming to "key
  compatibility", or get real validation from the gated `npm run test:e2e` real-binary run.
  (Round-1 review of the 0.80.10 guards, 2026-07-20; Minor.)

## Dead surface
- `AttemptOutcome.exitCode` / `signal` are populated but unused by any caller (exit code is
  deliberately NOT used for classification). Remove, or wire `stderr` into more surfacing.
- `FailoverPlan.prompt` is declared but never read by `runFailover` (the prompt reaches pi via the
  bin's `launchAttempt` closure). Drop the field or thread it through `FailoverDeps.launchAttempt`.
