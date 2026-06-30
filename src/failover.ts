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
