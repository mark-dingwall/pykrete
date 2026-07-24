import { readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";

export interface CatalogConfig {
  ttlSeconds: number;
}

export interface LivenessConfig {
  nonceEnabled: boolean;
  idleTimeoutSeconds: number;
  resumeAttempts: number;
  startupTimeoutSeconds: number;
  overallTimeoutSeconds: number;
  deadlineSeconds: number;
  killGraceSeconds: number;
  probeTimeoutSeconds: number;
}

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxRetryDelayMs: number;
  outageBackoffBaseMs: number;
  outageBackoffFactor: number;
  outageBackoffCapMs: number;
  maxOutageRetries: number;
}

export interface Config {
  defaultFamily: string;
  catalog: CatalogConfig;
  families: Record<string, string[]>;
  defaults: Record<string, Record<string, string>>;
  liveness: LivenessConfig;
  retry: RetryConfig;
}

export class ConfigError extends Error {}

const DEFAULT_TTL = 3600;

// idleTimeoutSeconds default 330 sits deliberately OUTSIDE pi's 300s HTTP idle window (see Global
// Constraints) so pi's own abort/self-retry fires before Pykrete's watchdog. resumeAttempts default 1;
// note the deadline caveat below (a single candidate's resume loop can consume up to
// (resumeAttempts+1) x overallTimeoutSeconds of non-paused wall-time, since the overall deadline is
// enforced BETWEEN candidates, not within one — see Task 8 design note).
const DEFAULT_LIVENESS: LivenessConfig = {
  nonceEnabled: true,
  idleTimeoutSeconds: 330,
  resumeAttempts: 1,
  startupTimeoutSeconds: 180,
  overallTimeoutSeconds: 1800,
  deadlineSeconds: 3600,
  killGraceSeconds: 5,
  probeTimeoutSeconds: 4,
};

// maxRetries/baseDelayMs/maxRetryDelayMs are pi's own same-model transient retry, passed through to
// the generated settings.json. outageBackoff*/maxOutageRetries are Pykrete's own reachability-probe
// backoff ladder in runCandidate.ts (distinct mechanism: retrying a probe, not a model request).
const DEFAULT_RETRY: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 2000,
  maxRetryDelayMs: 60000,
  outageBackoffBaseMs: 1000,
  outageBackoffFactor: 2,
  outageBackoffCapMs: 1_024_000,
  maxOutageRetries: 10,
};

export function parseConfig(raw: unknown): Config {
  if (typeof raw !== "object" || raw === null) {
    throw new ConfigError("config root must be a table");
  }
  const root = raw as Record<string, unknown>;

  // families — single source of truth
  const familiesRaw = root.families;
  if (typeof familiesRaw !== "object" || familiesRaw === null) {
    throw new ConfigError("[families] table is required");
  }
  const families: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(familiesRaw as Record<string, unknown>)) {
    if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === "string")) {
      throw new ConfigError(`[families].${name} must be a non-empty list of strings`);
    }
    families[name] = value as string[];
  }
  if (Object.keys(families).length === 0) {
    throw new ConfigError("[families] must define at least one family");
  }

  // default_family
  const defaultFamily = root.default_family;
  if (typeof defaultFamily !== "string" || !(defaultFamily in families)) {
    throw new ConfigError(`default_family "${String(defaultFamily)}" is not a defined family`);
  }

  // defaults — every id must be an element of its family list (equality)
  const defaults: Record<string, Record<string, string>> = {};
  const defaultsRaw = root.defaults;
  if (defaultsRaw !== undefined) {
    if (typeof defaultsRaw !== "object" || defaultsRaw === null) {
      throw new ConfigError("[defaults] must be a table");
    }
    for (const [task, perFamilyRaw] of Object.entries(defaultsRaw as Record<string, unknown>)) {
      if (typeof perFamilyRaw !== "object" || perFamilyRaw === null) {
        throw new ConfigError(`[defaults.${task}] must be a table`);
      }
      const perFamily: Record<string, string> = {};
      for (const [family, id] of Object.entries(perFamilyRaw as Record<string, unknown>)) {
        if (typeof id !== "string") {
          throw new ConfigError(`[defaults.${task}].${family} must be a string`);
        }
        if (!(family in families)) {
          throw new ConfigError(`[defaults.${task}].${family} references unknown family "${family}"`);
        }
        if (!families[family].includes(id)) {
          throw new ConfigError(`[defaults.${task}].${family} = "${id}" is not in [families].${family}`);
        }
        perFamily[family] = id;
      }
      defaults[task] = perFamily;
    }
  }

  // catalog.ttl_seconds
  let ttlSeconds = DEFAULT_TTL;
  const catalogRaw = root.catalog;
  if (catalogRaw !== undefined) {
    if (typeof catalogRaw !== "object" || catalogRaw === null) {
      throw new ConfigError("[catalog] must be a table");
    }
    const ttl = (catalogRaw as Record<string, unknown>).ttl_seconds;
    if (ttl !== undefined) {
      if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl <= 0) {
        throw new ConfigError("[catalog].ttl_seconds must be a positive integer");
      }
      ttlSeconds = ttl;
    }
  }

  // liveness — transport-liveness knobs; all optional with reliability-first defaults.
  const liveness: LivenessConfig = { ...DEFAULT_LIVENESS };
  const livenessRaw = root.liveness;
  if (livenessRaw !== undefined) {
    if (typeof livenessRaw !== "object" || livenessRaw === null) {
      throw new ConfigError("[liveness] must be a table");
    }
    const l = livenessRaw as Record<string, unknown>;
    if (l.nonce_enabled !== undefined) {
      if (typeof l.nonce_enabled !== "boolean") throw new ConfigError("[liveness].nonce_enabled must be a boolean");
      liveness.nonceEnabled = l.nonce_enabled;
    }
    if (l.idle_timeout_seconds !== undefined) {
      const v = l.idle_timeout_seconds;
      if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
        throw new ConfigError("[liveness].idle_timeout_seconds must be a positive integer");
      }
      liveness.idleTimeoutSeconds = v;
    }
    if (l.resume_attempts !== undefined) {
      const v = l.resume_attempts;
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
        throw new ConfigError("[liveness].resume_attempts must be a non-negative integer");
      }
      liveness.resumeAttempts = v;
    }
    if (l.startup_timeout_seconds !== undefined) {
      const v = l.startup_timeout_seconds;
      if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
        throw new ConfigError("[liveness].startup_timeout_seconds must be a positive integer");
      }
      liveness.startupTimeoutSeconds = v;
    }
    if (l.overall_timeout_seconds !== undefined) {
      const v = l.overall_timeout_seconds;
      if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
        throw new ConfigError("[liveness].overall_timeout_seconds must be a positive integer");
      }
      liveness.overallTimeoutSeconds = v;
    }
    if (l.deadline_seconds !== undefined) {
      const v = l.deadline_seconds;
      if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
        throw new ConfigError("[liveness].deadline_seconds must be a positive integer");
      }
      liveness.deadlineSeconds = v;
    }
    if (l.kill_grace_seconds !== undefined) {
      const v = l.kill_grace_seconds;
      if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
        throw new ConfigError("[liveness].kill_grace_seconds must be a positive integer");
      }
      liveness.killGraceSeconds = v;
    }
    if (l.probe_timeout_seconds !== undefined) {
      const v = l.probe_timeout_seconds;
      if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
        throw new ConfigError("[liveness].probe_timeout_seconds must be a positive integer");
      }
      liveness.probeTimeoutSeconds = v;
    }
  }

  // retry — pi's native retry passthrough plus Pykrete's own outage-backoff ladder. All optional
  // with defaults matching the prior hardcoded constants.
  const retry: RetryConfig = { ...DEFAULT_RETRY };
  const retryRaw = root.retry;
  if (retryRaw !== undefined) {
    if (typeof retryRaw !== "object" || retryRaw === null) {
      throw new ConfigError("[retry] must be a table");
    }
    const r = retryRaw as Record<string, unknown>;
    if (r.max_retries !== undefined) {
      const v = r.max_retries;
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
        throw new ConfigError("[retry].max_retries must be a non-negative integer");
      }
      retry.maxRetries = v;
    }
    if (r.base_delay_ms !== undefined) {
      const v = r.base_delay_ms;
      if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
        throw new ConfigError("[retry].base_delay_ms must be a positive integer");
      }
      retry.baseDelayMs = v;
    }
    if (r.max_retry_delay_ms !== undefined) {
      const v = r.max_retry_delay_ms;
      if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
        throw new ConfigError("[retry].max_retry_delay_ms must be a positive integer");
      }
      retry.maxRetryDelayMs = v;
    }
    if (r.outage_backoff_base_ms !== undefined) {
      const v = r.outage_backoff_base_ms;
      if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
        throw new ConfigError("[retry].outage_backoff_base_ms must be a positive integer");
      }
      retry.outageBackoffBaseMs = v;
    }
    if (r.outage_backoff_factor !== undefined) {
      const v = r.outage_backoff_factor;
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 1) {
        throw new ConfigError("[retry].outage_backoff_factor must be a number greater than 1");
      }
      retry.outageBackoffFactor = v;
    }
    if (r.outage_backoff_cap_ms !== undefined) {
      const v = r.outage_backoff_cap_ms;
      if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
        throw new ConfigError("[retry].outage_backoff_cap_ms must be a positive integer");
      }
      retry.outageBackoffCapMs = v;
    }
    if (r.max_outage_retries !== undefined) {
      const v = r.max_outage_retries;
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
        throw new ConfigError("[retry].max_outage_retries must be a non-negative integer");
      }
      retry.maxOutageRetries = v;
    }
  }

  // Cross-field: cap must be able to hold at least one ladder step, or gate() in runCandidate.ts
  // gives up on the first outage with zero backoff — silently disabling the whole mechanism.
  // Checked against the fully-resolved values so a lone override of either field is still caught.
  if (retry.outageBackoffCapMs < retry.outageBackoffBaseMs) {
    throw new ConfigError(
      "[retry].outage_backoff_cap_ms must be >= outage_backoff_base_ms (otherwise the backoff ladder never runs and a single outage blip gives up immediately)",
    );
  }

  return { defaultFamily, catalog: { ttlSeconds }, families, defaults, liveness, retry };
}

export function loadConfig(path: string): Config {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err) {
    throw new ConfigError(`cannot read config at ${path}: ${(err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (err) {
    throw new ConfigError(`invalid TOML in ${path}: ${(err as Error).message}`);
  }
  return parseConfig(raw);
}
