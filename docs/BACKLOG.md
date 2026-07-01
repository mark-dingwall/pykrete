# Pykrete backlog

Items deferred from the Spec B failover state machine (pre-merge multi-AI review, 2026-07-01).
Not blocking merge; recorded so future reviews don't re-discover them cold.

## Follow-up branch (transport liveness — decided 2026-07-01)
- **Sentinel-nonce → `pi --continue` resume.** A genuine terminal silent-stop (stopReason `stop`/
  `length` with empty/partial reconstructed text) still reports exit 0 today. The in-scope liveness
  mechanism (design doc l.218–222) is nonce injection + nonce-missing → state-aware resume; it is a
  whole feature, deferred to its own branch. The *truncation-before-terminal* case is already
  handled (terminal-only stopReason latch → ambiguous → failover).
- **Idle / no-progress watchdog.** A mid-inference model stall (pi emits `agent_start` ~700 ms before
  contacting the model, disarming the startup watchdog) is caught only by the overall timer →
  surfaced as exit 1, not failed over. Add a no-progress watchdog (kill + classify model-unavailable
  when `idleMs` exceeds a cap before any output). Existing "Known v1 boundary" in the design doc.
- **Live streaming** of `message_update` token deltas to stdout (design doc l.247).

## Reliability / robustness
- **Process-group / detached grandchild kill.** The hang backstop force-resolves and unrefs, so the
  Pykrete process exits, but a grandchild that inherited the stdout pipe is abandoned (left running).
  Spawn `detached` + `process.kill(-pid)` on escalation to reap the whole tree.
- **`createAgentDir` throw → clean exit.** A write failure now self-cleans then rethrows, which
  escapes `main()` as an unhandled rejection (Node prints a stack trace, exits 1). Exit code is
  contract-correct; catch it in bin for a clean `pykrete: …` message instead.
- **Cap stderr accumulation.** `launch.ts` grows `stderr` unbounded; keep only the last N KB.

## Tests / observability
- **bin exit-1 e2e** (fatal/transient run-error) case — the matrix covers 0/2/3/4 but not 1.
- **Negative-space stdout assertion** — `assert.doesNotMatch(stdout, /pykrete:/)` so diagnostics
  can't regress onto stdout.
- classify: assert the `.message` field on fatal/transient verdicts; `parseStatus` anchor guard test;
  unknown-`stopReason` coverage.

## Dead surface
- `AttemptOutcome.exitCode` / `signal` are populated but unused by any caller (exit code is
  deliberately NOT used for classification). Remove, or wire `stderr` into more surfacing.
- `FailoverPlan.prompt` is declared but never read by `runFailover` (the prompt reaches pi via the
  bin's `launchAttempt` closure). Drop the field or thread it through `FailoverDeps.launchAttempt`.
