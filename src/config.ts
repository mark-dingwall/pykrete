import { readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";

export interface CatalogConfig {
  ttlSeconds: number;
}

export interface LivenessConfig {
  nonceEnabled: boolean;
  idleTimeoutSeconds: number;
  resumeAttempts: number;
}

export interface Config {
  defaultFamily: string;
  catalog: CatalogConfig;
  families: Record<string, string[]>;
  defaults: Record<string, Record<string, string>>;
  liveness: LivenessConfig;
}

export class ConfigError extends Error {}

const DEFAULT_TTL = 3600;

// idleTimeoutSeconds default 330 sits deliberately OUTSIDE pi's 300s HTTP idle window (see Global
// Constraints) so pi's own abort/self-retry fires before Pykrete's watchdog. resumeAttempts default 1;
// note the deadline caveat below (a single candidate's resume loop can consume up to
// (resumeAttempts+1) x OVERALL_TIMEOUT_MS of non-paused wall-time, since the overall deadline is
// enforced BETWEEN candidates, not within one — see Task 8 design note).
const DEFAULT_LIVENESS: LivenessConfig = { nonceEnabled: true, idleTimeoutSeconds: 330, resumeAttempts: 1 };

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
  }

  return { defaultFamily, catalog: { ttlSeconds }, families, defaults, liveness };
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
