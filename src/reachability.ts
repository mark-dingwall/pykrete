import { MODELS_URL } from "./catalog.ts";

export type Reachability = "up" | "down" | "throttled";

export interface ReachabilityDeps {
  fetchImpl: typeof fetch;
  apiKey: string | undefined;
  timeoutMs?: number;
  url?: string;
}

const DEFAULT_PROBE_TIMEOUT_MS = 4_000;

// A single GET /models is a cheap, already-plumbed proxy for /chat/completions reachability.
// Spike AR-2: /models is a PUBLIC endpoint (200 with any/no/bogus key), so the probe cannot detect a
// bad key — auth is caught by classify on the inference 401. The probe reports reachability only:
// up (200) / throttled (429) / down (everything else). Accepted limitation: the metadata gateway
// being up does not 100% guarantee inference is up.
export async function probeNanoGpt(deps: ReachabilityDeps): Promise<Reachability> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await deps.fetchImpl(deps.url ?? MODELS_URL, {
      headers: { Authorization: `Bearer ${deps.apiKey ?? ""}` },
      signal: controller.signal,
    });
    if (res.status === 429) return "throttled"; // reachable but rate-limited (D6): back off, don't cascade
    if (res.ok) return "up";
    return "down"; // any 5xx / 4xx / other non-2xx: could not confirm reachability
  } catch {
    return "down"; // timeout (abort), DNS, connection reset
  } finally {
    clearTimeout(timer);
  }
}
