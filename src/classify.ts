import type { PiRunOutcome } from "./pi-events.ts";

export type Verdict =
  | { kind: "success" }
  | { kind: "incomplete"; message: string }
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
  if (/model_not_supported|unknown model/i.test(errorMessage)) return true;
  // A bare "not supported" / "does not exist" can describe an endpoint, account tier, or request
  // parameter — not the model. Only treat it as model-unavailability when it co-occurs with the
  // word "model"; otherwise it is fatal. (A request-shaped 400 recurs identically on every
  // candidate, so failing over on it only wastes attempts and over-claims exit 4.)
  return /\bmodel\b/i.test(errorMessage) && /not supported|does not exist|not found|not available|unavailable|no such/i.test(errorMessage);
}

export function classify(
  outcome: PiRunOutcome,
  flags: { startupTimedOut: boolean; overallTimedOut: boolean },
  noncePresent?: boolean,
): Verdict {
  // A startup stall (pi emitted no first line in time) is failover-eligible but NOT a clean
  // model-unavailable signal — it can equally be a transient/local hiccup. Classify it ambiguous
  // so it still fails over to the next candidate, yet an all-candidates startup-stall does not
  // aggregate to exit 4 ("family unavailable") in failover.ts; it surfaces as exit 1.
  if (flags.startupTimedOut) return { kind: "ambiguous", message: "no response before startup timeout" };
  if (flags.overallTimedOut) return { kind: "transient", message: "attempt timed out" };

  const { stopReason, errorMessage, model } = outcome;
  if (stopReason === undefined) return { kind: "ambiguous", message: "no terminal message from pi" };
  // A clean terminal stop is success ONLY if the liveness nonce is present (or the nonce is disabled,
  // i.e. noncePresent === undefined -> Spec B behaviour). A clean stop with the nonce missing is a
  // silent-stop (S1): the model quit cleanly but never signalled completion -> drive a resume.
  if (stopReason === "stop" || stopReason === "length") {
    if (noncePresent === false) return { kind: "incomplete", message: "clean stop without completion nonce" };
    return { kind: "success" };
  }
  if (stopReason === "aborted") return { kind: "transient", message: "run aborted" };

  const message = errorMessage ?? "unknown error";
  const status = parseStatus(message);
  if (status === 401 || status === 402) return { kind: "fatal", message };
  if (status === 404) return { kind: "model-unavailable" };
  // 403: a model gated to the account/plan is model-unavailable (fail over); a key- or
  // endpoint-level forbidden is fatal — every candidate shares the same key, so failover only
  // delays the inevitable and would over-claim exit 4. Disambiguate by model reference.
  if (status === 403) return modelReferenced(message, model) ? { kind: "model-unavailable" } : { kind: "fatal", message };
  // A 400 without a model reference is treated as fatal (not failover) because Pykrete sends an
  // IDENTICAL request to every candidate, so a malformed-request 400 would recur on all of them.
  // This safety depends on request-uniformity; revisit when per-model compat flags (deferred) land,
  // since a 400 fatal for one model could then succeed on another.
  if (status === 400) return modelReferenced(message, model) ? { kind: "model-unavailable" } : { kind: "fatal", message };
  // 413 is the same request-uniformity argument as the 400 above: the body itself is too large, so
  // the identical oversized request recurs on every candidate and failing over only burns the rest.
  // It never references a model, so no disambiguation is needed. On large-context models this is
  // what an oversized prompt actually surfaces as — DS4's 1,048,576-token window needs >4 MiB of
  // prompt, which trips NanoGPT's body limit before any context check, making the 400
  // context_length_exceeded path unreachable there (live-captured on pi 0.80.10).
  if (status === 413) return { kind: "fatal", message };
  if (status === 408 || status === 429 || (status !== undefined && status >= 500)) return { kind: "transient", message };
  return { kind: "ambiguous", message };
}
