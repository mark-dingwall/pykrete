# Pykrete stability-test methodology (adopted from llm-bench)

**Date:** 2026-06-29
**Status:** Notes for the planned Pykrete stability tests. Distilled from the ancestor bench
harness (`~/tools/llm-bench/2026-04-26/`, pi v0.70.2) and reconciled with the 2026-06-29 pi
error-surface findings (`2026-06-29-launcher-failover-design.md`).
**Framing:** Pykrete ≈ "pi + NanoGPT, but reliable." These tests measure **transport reliability**,
not output quality. Verdict gates (complete? correct? over-claimed?) are OUT of scope per
Contract 06-05 — the bench's 15-gate Haiku/Sonnet judge engine is NOT adopted.

## Two test classes (keep them separate)

**(1) Deterministic mechanism tests — fault injection.** The part the bench did NOT do but Pykrete
must, because Pykrete *is* the reliability layer: inject a fault, assert Pykrete's response. These
are repeatable and CI-able. Seeded by today's empirical probes (exact shapes to assert against):

| Inject | Expectation |
|---|---|
| bogus `--model` id (NanoGPT `400 … model_not_supported`) | fail over to next candidate; run still succeeds if any candidate lives |
| all candidates bogus | run-error naming the family; clean exit; no crash/`TypeError` |
| bad API key (`401 Invalid session`) | **fatal**, no pointless failover across candidates |
| insufficient balance (`402`) | **fatal** |
| child killed mid-stream / sentinel nonce absent | nonce-missing → `pi --continue` resume fires |
| substituted id (launched ≠ `intended_lead`) | downgrade signal emitted (distinct exit code / marker) |

Determinism comes from injecting the fault, not from hoping a real model misbehaves. A fake/local
endpoint or a request interceptor returning canned NanoGPT error bodies makes these fast and offline.

**(2) Probabilistic reliability sweeps — real models, real NanoGPT.** Characterize the residual
flakiness Pykrete can only *absorb*, not eliminate (NanoGPT translator leaks, model silent-stops).
Monitoring-grade, not a pass/fail gate. Re-run on pi/NanoGPT updates and watch the trend.

## Practices worth adopting

- **Statistical, never single-shot.** N≥10 runs per cell `(family × condition)`; report a **pass-rate
  + failure-type histogram**, not a single green/red. The bench's own data is the argument:
  DeepSeek-Flash was 0/10 on one transport and 10/10 on another — one run proves nothing.
- **Sentinel nonce = the liveness oracle.** Primary pass signal for a transport test = "did the run
  emit the nonce?" (silent-stop detection — the dominant real failure). Pair it with the existing
  deterministic task (`experiments/stress-spec.md` number-words: 30 named files, exact spellings) so
  completion is checkable mechanically, with zero LLM judging. In-scope precisely because
  nonce→resume is Pykrete's mechanism.
- **Bucketed failure taxonomy, not pass/fail.** Classify every failure: silent-stop (nonce missing /
  0 text events), stream-truncation / framing-leak (count native markers — `<｜DSML｜tool_calls｜>`,
  `<|tool_call_end|>` — in `delta.content`), stall/spiral (tool-call count, wall-clock,
  consecutive-empty-turns), HTTP-fatal (401/402), model-unavailable (400/404 — and did failover
  fire?), failover-exhausted. The leak-count metric is cheap and the best early signal of translator
  drift.
- **Watchdog (notify + categorize + bundle) + heartbeat.** Long sweeps need stall/spiral cutoffs:
  thresholds on tool-call count, wall-clock, consecutive empty turns. The bench's watchdog paused for
  a human; an automated stability run should categorize, kill (SIGINT→SIGTERM→SIGKILL), and write an
  anomaly bundle. Heartbeat = periodic diagnostic event so "hung" is distinguishable from "slow."
- **Anomaly-capture bundle.** On any failure, snapshot full event JSONL + segmented child stderr +
  session state to a per-run dir. Keeps bulk telemetry out of the pass/fail decision (and out of an
  orchestrator's context — read bundles offline).
- **Control transport.** Pykrete is NanoGPT-only by constraint, but keep a control lane (OpenRouter,
  or pi-direct to a known-good provider) in the *sweep* to isolate "NanoGPT/pi flakiness" from
  "Pykrete bug." Clean control + dirty NanoGPT ⇒ upstream; Pykrete's job is to absorb, not fix.
- **Date every sweep.** Record exact pi commit + NanoGPT probe date with each run (bench did this via
  `pi-version.txt`). Both ship fast; a result without a version stamp decays silently.

## Explicitly NOT adopted

- LLM judge gates (Haiku tri-state / Sonnet binary), spec-compliance, over-claim detection,
  pre-existing-test diffing — all verdict-gate / output-quality concerns, out of Pykrete scope.
- Multi-provider routing tables as a *product* feature (the bench rerouted Flash→OpenRouter);
  Pykrete stays NanoGPT-only and selects *within* it via the family resolver + advisory catalog.

## Reuse already in-repo

- `experiments/stress-spec.md` — the deterministic number-words task (good completion oracle).
- `.research/stress-sweep-forensics.md` — prior sweep forensics.
- `experiments/agentdir/`, `tap/tap.mjs` (capture tap, port 8377) — existing capture plumbing.
