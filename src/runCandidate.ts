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
