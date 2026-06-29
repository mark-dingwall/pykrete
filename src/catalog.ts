import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function reorder(candidates: string[], catalog: Set<string>): string[] {
  const present: string[] = [];
  const absent: string[] = [];
  for (const id of candidates) {
    (catalog.has(id) ? present : absent).push(id);
  }
  return [...present, ...absent];
}

export function intersects(candidates: string[], catalog: Set<string>): boolean {
  return candidates.some((id) => catalog.has(id));
}

export const MODELS_URL = "https://nano-gpt.com/api/v1/models?detailed=true";

export interface LoadCatalogOptions {
  apiKey: string | undefined;
  ttlSeconds: number;
  cacheDir: string;
  fetchImpl?: typeof fetch;
  now?: number;
  warn?: (msg: string) => void;
}

export async function loadCatalog(opts: LoadCatalogOptions): Promise<Set<string> | null> {
  const { apiKey, ttlSeconds, cacheDir } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now();
  const warn = opts.warn ?? ((m: string) => console.error(m));

  if (!apiKey) {
    warn("pykrete: NANOGPT_API_KEY not set; skipping catalog reorder");
    return null;
  }

  const keyHash = createHash("sha256").update(apiKey).digest("hex");
  const cacheFile = join(cacheDir, `catalog-${keyHash}.json`);

  // Fresh cache by mtime -> use without a network call.
  try {
    const stat = statSync(cacheFile);
    if (now - stat.mtimeMs < ttlSeconds * 1000) {
      const ids = parseIds(readFileSync(cacheFile, "utf-8"));
      if (ids && ids.size > 0) return ids;
      // corrupt/empty fresh cache: fall through to fetch
    }
  } catch {
    // no cache file: fall through to fetch
  }

  // Fetch. Any failure -> no usable catalog (never a stale fallback).
  let ids: Set<string> | null = null;
  try {
    const res = await fetchImpl(MODELS_URL, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) {
      warn(`pykrete: catalog fetch failed (HTTP ${res.status}); proceeding without reorder`);
      return null;
    }
    ids = extractIds(await res.json());
  } catch (err) {
    warn(`pykrete: catalog fetch error (${(err as Error).message}); proceeding without reorder`);
    return null;
  }

  if (!ids || ids.size === 0) {
    warn("pykrete: catalog response had no usable model ids; proceeding without reorder");
    return null;
  }

  // Persist atomically: unique temp in the same dir, then rename. Best-effort.
  const tmpFile = join(cacheDir, `catalog-${keyHash}.${process.pid}.${randomUUID()}.tmp`);
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(tmpFile, JSON.stringify([...ids]));
    renameSync(tmpFile, cacheFile);
  } catch {
    // cache write is non-essential; clean up any orphaned temp, then ignore
    try {
      unlinkSync(tmpFile);
    } catch {
      // temp may not exist; nothing to clean
    }
  }
  return ids;
}

function parseIds(text: string): Set<string> | null {
  try {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) return null;
    return new Set(arr.filter((x): x is string => typeof x === "string"));
  } catch {
    return null;
  }
}

function extractIds(json: unknown): Set<string> | null {
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data)) return null;
  const ids = data
    .map((m) => (m as { id?: unknown })?.id)
    .filter((id): id is string => typeof id === "string");
  return new Set(ids);
}
