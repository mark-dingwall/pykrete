# Family Resolver Implementation Plan (Spec A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Pykrete's family resolver — turn `(--task, --family)` plus a `pykrete.toml` into an ordered, deduped list of concrete NanoGPT model ids (best-first) plus an `intendedLead`, advisorily re-ordered by the live model catalog, where nothing in the path can ever stop a run.

**Architecture:** Pure resolution core (config load+lint → `buildCandidates` → arg normalization) wrapped by an advisory catalog client (fetch/cache the NanoGPT `/models` id set, stable-partition known-live ids to the front, never drop/never error). A thin CLI wires them and emits diagnostics to stderr only. The launcher that consumes `(candidates, intendedLead)` and spawns pi is **Spec B** and out of scope here.

**Tech Stack:** TypeScript run natively on Node (`--experimental-strip-types`, matching pi's `.ts`-extension import style), `smol-toml` for TOML, built-in `node:test` + `node:assert/strict` for tests, `node:crypto`/`node:fs` for the cache. No framework.

## Global Constraints

- **Runtime:** Node ≥ 22.6, TypeScript sources run via `node --experimental-strip-types`. Imports use explicit `.ts` extensions (e.g. `import { x } from "./config.ts"`).
- **Reliability is prime:** nothing in the resolution path may stop a run. The only hard errors are at the CLI *before* resolution: unknown `--family` and config lint failures (exit code **2**). The catalog can never drop a candidate, never error, never stop a run.
- **Output contract:** `run(...)` yields `{ candidates: string[], intendedLead: string, ... }`. `candidates` is non-empty, deduped, best-first. `intendedLead` is the pre-reorder `candidates[0]` (the intent-precedence winner) — Spec B's substitution baseline.
- **Diagnostics → stderr only.** stdout belongs to the run result (Spec B). All warnings prefixed `pykrete: `.
- **Catalog source:** authed `GET https://nano-gpt.com/api/v1/models?detailed=true`, `Authorization: Bearer <key>`, key from env `NANOGPT_API_KEY`. Response shape is OpenAI-style `{ data: [{ id, ... }] }`.
- **Cache:** `${XDG_CACHE_HOME:-~/.cache}/pykrete/catalog-<sha256(key)>.json`, freshness by file **mtime** vs `ttl_seconds`. Atomic write via uniquely-named temp file (`pid` + nonce) in the same dir, then rename. No stale fallback. Never persist an empty/garbage response.
- **Ids matched exactly** against the catalog — suffixes (`:thinking`) and prefixes (`TEE/`) are first-class, never normalized/stripped.
- **DRY, YAGNI, TDD, frequent commits.** Deferred (do NOT build): single-flight refetch dedup, intra-family duplicate-id lint, configurable intent-vs-quality ordering knob.

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json` | Project manifest, scripts, `smol-toml` dep |
| `tsconfig.json` | Typecheck config (`tsc --noEmit`) |
| `src/config.ts` | Load + parse + lint `pykrete.toml`; `Config` type; `ConfigError` |
| `src/resolve.ts` | Pure `buildCandidates`; `Resolution` type |
| `src/args.ts` | Pure arg normalization `resolveArgs`; `FamilyError` |
| `src/catalog.ts` | Pure `reorder`/`intersects` + IO `loadCatalog` (fetch/cache) |
| `src/cli.ts` | `parseArgv` + `run` orchestration (exported, testable) |
| `bin/pykrete.ts` | Executable shim: calls `run`, maps errors to exit codes |

Test files sit beside their source: `src/<name>.test.ts`.

---

## Task 1: Project scaffold + config load/lint

**Files:**
- Create: `package.json`, `tsconfig.json`, `src/config.ts`, `src/config.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `interface CatalogConfig { ttlSeconds: number }`
  - `interface Config { defaultFamily: string; catalog: CatalogConfig; families: Record<string, string[]>; defaults: Record<string, Record<string, string>> }`
  - `class ConfigError extends Error {}`
  - `function parseConfig(raw: unknown): Config`
  - `function loadConfig(path: string): Config`

- [ ] **Step 1: Scaffold the project**

Create `package.json`:

```json
{
  "name": "pykrete",
  "version": "0.1.0",
  "type": "module",
  "bin": { "pykrete": "bin/pykrete.ts" },
  "engines": { "node": ">=22.6" },
  "scripts": {
    "test": "node --experimental-strip-types --test 'src/**/*.test.ts'",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": { "smol-toml": "^1.3.1" },
  "devDependencies": { "typescript": "^5.5.0", "@types/node": "^22.0.0" }
}
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "bin"]
}
```

Then install: `npm install`

- [ ] **Step 2: Write the failing test**

Create `src/config.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, loadConfig, ConfigError, type Config } from "./config.ts";

const VALID = {
  default_family: "glm",
  catalog: { ttl_seconds: 1800 },
  families: {
    glm: ["zai-org/glm-5.2:thinking", "zai-org/glm-5.2", "zai-org/glm-5.1:thinking"],
    kimi: ["moonshotai/kimi-k2.6:thinking", "moonshotai/kimi-k2.7-code"],
  },
  defaults: {
    general: { glm: "zai-org/glm-5.2", kimi: "moonshotai/kimi-k2.6:thinking" },
    code: { glm: "zai-org/glm-5.2:thinking", kimi: "moonshotai/kimi-k2.7-code" },
  },
};

const clone = () => structuredClone(VALID);

test("parses a valid config", () => {
  const cfg: Config = parseConfig(VALID);
  assert.equal(cfg.defaultFamily, "glm");
  assert.equal(cfg.catalog.ttlSeconds, 1800);
  assert.deepEqual(cfg.families.glm, VALID.families.glm);
  assert.equal(cfg.defaults.code.kimi, "moonshotai/kimi-k2.7-code");
});

test("ttl_seconds defaults to 3600 when omitted", () => {
  const raw = clone();
  delete (raw as Record<string, unknown>).catalog;
  assert.equal(parseConfig(raw).catalog.ttlSeconds, 3600);
});

test("[defaults.general] is not required", () => {
  const raw = clone();
  delete (raw.defaults as Record<string, unknown>).general;
  assert.doesNotThrow(() => parseConfig(raw));
});

test("a family with no defaults entry is legal", () => {
  const raw = clone();
  (raw.families as Record<string, string[]>).deepseek = ["TEE/deepseek-v4-pro:thinking"];
  assert.doesNotThrow(() => parseConfig(raw));
});

test("bare-string family value is rejected", () => {
  const raw = clone();
  (raw.families as Record<string, unknown>).glm = "zai-org/glm-5.2";
  assert.throws(() => parseConfig(raw), ConfigError);
});

test("empty family list is rejected", () => {
  const raw = clone();
  (raw.families as Record<string, unknown>).glm = [];
  assert.throws(() => parseConfig(raw), ConfigError);
});

test("defaults id not in its family list is rejected", () => {
  const raw = clone();
  raw.defaults.code.glm = "zai-org/glm-9.9";
  assert.throws(() => parseConfig(raw), ConfigError);
});

test("defaults referencing an unknown family is rejected", () => {
  const raw = clone();
  (raw.defaults.code as Record<string, string>).mystery = "x/y";
  assert.throws(() => parseConfig(raw), ConfigError);
});

test("default_family absent from families is rejected", () => {
  const raw = clone();
  raw.default_family = "nope";
  assert.throws(() => parseConfig(raw), ConfigError);
});

test("ttl_seconds zero or negative is rejected", () => {
  const zero = clone();
  zero.catalog.ttl_seconds = 0;
  assert.throws(() => parseConfig(zero), ConfigError);
  const neg = clone();
  neg.catalog.ttl_seconds = -5;
  assert.throws(() => parseConfig(neg), ConfigError);
});

test("loadConfig reads and parses a TOML file", () => {
  const dir = mkdtempSync(join(tmpdir(), "pykrete-"));
  const path = join(dir, "pykrete.toml");
  writeFileSync(
    path,
    [
      'default_family = "glm"',
      "[families]",
      'glm = ["zai-org/glm-5.2:thinking", "zai-org/glm-5.2"]',
      "[defaults.code]",
      'glm = "zai-org/glm-5.2:thinking"',
    ].join("\n"),
  );
  const cfg = loadConfig(path);
  assert.equal(cfg.defaultFamily, "glm");
  assert.equal(cfg.defaults.code.glm, "zai-org/glm-5.2:thinking");
});

test("loadConfig on a missing file throws ConfigError", () => {
  assert.throws(() => loadConfig("/no/such/pykrete.toml"), ConfigError);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './config.ts'` (source not written yet).

- [ ] **Step 4: Write the implementation**

Create `src/config.ts`:

```ts
import { readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";

export interface CatalogConfig {
  ttlSeconds: number;
}

export interface Config {
  defaultFamily: string;
  catalog: CatalogConfig;
  families: Record<string, string[]>;
  defaults: Record<string, Record<string, string>>;
}

export class ConfigError extends Error {}

const DEFAULT_TTL = 3600;

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

  return { defaultFamily, catalog: { ttlSeconds }, families, defaults };
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all `config.test.ts` tests green.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json src/config.ts src/config.test.ts
git commit -m "feat: config load + lint for the family resolver"
```

---

## Task 2: Pure candidate builder

**Files:**
- Create: `src/resolve.ts`, `src/resolve.test.ts`

**Interfaces:**
- Consumes: `Config` from `./config.ts`.
- Produces:
  - `interface Resolution { candidates: string[]; intendedLead: string }`
  - `function buildCandidates(config: Config, task: string, family: string): Resolution`
    — assumes `family` is already validated against `config.families`. Intent-precedence chain `[task pick, general pick, ...ranked family list]`, deduped keeping first occurrence. `intendedLead = candidates[0]`.

- [ ] **Step 1: Write the failing test**

Create `src/resolve.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config } from "./config.ts";
import { buildCandidates } from "./resolve.ts";

const cfg: Config = {
  defaultFamily: "glm",
  catalog: { ttlSeconds: 3600 },
  families: {
    glm: ["zai-org/glm-5.2:thinking", "zai-org/glm-5.2", "zai-org/glm-5.1:thinking"],
    kimi: ["moonshotai/kimi-k2.6:thinking", "moonshotai/kimi-k2.7-code"],
    deepseek: ["TEE/deepseek-v4-pro:thinking", "deepseek/deepseek-v3.2:thinking"],
  },
  defaults: {
    general: { glm: "zai-org/glm-5.2", kimi: "moonshotai/kimi-k2.6:thinking" },
    code: { glm: "zai-org/glm-5.2:thinking", kimi: "moonshotai/kimi-k2.7-code" },
  },
};

test("task ▸ general ▸ ranked, deduped (code/glm)", () => {
  const { candidates, intendedLead } = buildCandidates(cfg, "code", "glm");
  // chain: glm-5.2:thinking(code), glm-5.2(general), glm-5.2:thinking, glm-5.2, glm-5.1:thinking
  assert.deepEqual(candidates, [
    "zai-org/glm-5.2:thinking",
    "zai-org/glm-5.2",
    "zai-org/glm-5.1:thinking",
  ]);
  assert.equal(intendedLead, "zai-org/glm-5.2:thinking");
  assert.equal(intendedLead, candidates[0]);
});

test("general drives order when task has no entry for the family", () => {
  // 'code' has no deepseek entry; 'general' has none either -> straight ranked list
  const { candidates, intendedLead } = buildCandidates(cfg, "code", "deepseek");
  assert.deepEqual(candidates, cfg.families.deepseek);
  assert.equal(intendedLead, "TEE/deepseek-v4-pro:thinking");
});

test("general pick reorders ahead of ranked head (general/glm)", () => {
  const { candidates, intendedLead } = buildCandidates(cfg, "general", "glm");
  // general glm = glm-5.2 jumps ahead of ranked head glm-5.2:thinking
  assert.deepEqual(candidates, [
    "zai-org/glm-5.2",
    "zai-org/glm-5.2:thinking",
    "zai-org/glm-5.1:thinking",
  ]);
  assert.equal(intendedLead, "zai-org/glm-5.2");
});

test("dedup keeps first occurrence when task == general == ranked id", () => {
  const c: Config = {
    ...cfg,
    families: { mono: ["a", "b"] },
    defaults: { general: { mono: "a" }, code: { mono: "a" } },
    defaultFamily: "mono",
  };
  const { candidates } = buildCandidates(c, "code", "mono");
  assert.deepEqual(candidates, ["a", "b"]);
});

test("intendedLead is always the family ranked head when no defaults apply", () => {
  const { intendedLead } = buildCandidates(cfg, "general", "deepseek");
  assert.equal(intendedLead, cfg.families.deepseek[0]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern 'task ▸ general'`
Expected: FAIL — `Cannot find module './resolve.ts'`.

- [ ] **Step 3: Write the implementation**

Create `src/resolve.ts`:

```ts
import type { Config } from "./config.ts";

export interface Resolution {
  candidates: string[];
  intendedLead: string;
}

export function buildCandidates(config: Config, task: string, family: string): Resolution {
  const ranked = config.families[family];
  if (ranked === undefined) {
    throw new Error(`buildCandidates called with unvalidated family "${family}"`);
  }
  const taskPick = config.defaults[task]?.[family];
  const generalPick = config.defaults["general"]?.[family];

  const chain = [taskPick, generalPick, ...ranked].filter(
    (id): id is string => typeof id === "string",
  );

  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const id of chain) {
    if (!seen.has(id)) {
      seen.add(id);
      candidates.push(id);
    }
  }
  return { candidates, intendedLead: candidates[0] };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern 'glm|ranked|dedup|drives'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/resolve.ts src/resolve.test.ts
git commit -m "feat: pure intent-precedence candidate builder"
```

---

## Task 3: Argument normalization

**Files:**
- Create: `src/args.ts`, `src/args.test.ts`

**Interfaces:**
- Consumes: `Config` from `./config.ts`.
- Produces:
  - `class FamilyError extends Error {}`
  - `interface ResolvedArgs { task: string; family: string; warnings: string[] }`
  - `function resolveArgs(config: Config, rawTask: string | undefined, rawFamily: string | undefined): ResolvedArgs`
    — trims both; family defaults to `config.defaultFamily` when undefined, throws `FamilyError` if a given family is unknown (case-sensitive); task defaults to `"general"`, and an unknown non-`general` task normalizes to `"general"` with a warning string.

- [ ] **Step 1: Write the failing test**

Create `src/args.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config } from "./config.ts";
import { resolveArgs, FamilyError } from "./args.ts";

const cfg: Config = {
  defaultFamily: "glm",
  catalog: { ttlSeconds: 3600 },
  families: { glm: ["a"], kimi: ["b"] },
  defaults: { general: { glm: "a" }, code: { glm: "a" } },
};

test("undefined task and family use defaults with no warnings", () => {
  const r = resolveArgs(cfg, undefined, undefined);
  assert.equal(r.family, "glm");
  assert.equal(r.task, "general");
  assert.deepEqual(r.warnings, []);
});

test("known task and family pass through", () => {
  const r = resolveArgs(cfg, "code", "kimi");
  assert.equal(r.task, "code");
  assert.equal(r.family, "kimi");
  assert.deepEqual(r.warnings, []);
});

test("unknown task normalizes to general with a warning", () => {
  const r = resolveArgs(cfg, "docs", "glm");
  assert.equal(r.task, "general");
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /docs/);
});

test("explicit general task is accepted without warning even if absent from defaults", () => {
  const noGeneral: Config = { ...cfg, defaults: { code: { glm: "a" } } };
  const r = resolveArgs(noGeneral, "general", "glm");
  assert.equal(r.task, "general");
  assert.deepEqual(r.warnings, []);
});

test("family is trimmed before lookup", () => {
  const r = resolveArgs(cfg, undefined, "  glm  ");
  assert.equal(r.family, "glm");
});

test("unknown family throws FamilyError", () => {
  assert.throws(() => resolveArgs(cfg, undefined, "mystery"), FamilyError);
});

test("family match is case-sensitive", () => {
  assert.throws(() => resolveArgs(cfg, undefined, "GLM"), FamilyError);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern 'undefined task and family'`
Expected: FAIL — `Cannot find module './args.ts'`.

- [ ] **Step 3: Write the implementation**

Create `src/args.ts`:

```ts
import type { Config } from "./config.ts";

export class FamilyError extends Error {}

export interface ResolvedArgs {
  task: string;
  family: string;
  warnings: string[];
}

export function resolveArgs(
  config: Config,
  rawTask: string | undefined,
  rawFamily: string | undefined,
): ResolvedArgs {
  const warnings: string[] = [];

  let family: string;
  if (rawFamily === undefined) {
    family = config.defaultFamily;
  } else {
    family = rawFamily.trim();
    if (!(family in config.families)) {
      throw new FamilyError(`unknown family "${family}"`);
    }
  }

  let task = (rawTask ?? "general").trim();
  if (task === "") task = "general";
  if (task !== "general" && !(task in config.defaults)) {
    warnings.push(`unknown task "${task}", using "general"`);
    task = "general";
  }

  return { task, family, warnings };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern 'task|family'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/args.ts src/args.test.ts
git commit -m "feat: arg normalization with unknown-task fallback and family hard-error"
```

---

## Task 4: Pure catalog reorder

**Files:**
- Create: `src/catalog.ts`, `src/catalog.test.ts`

**Interfaces:**
- Consumes: nothing (pure functions over plain values).
- Produces:
  - `function reorder(candidates: string[], catalog: Set<string>): string[]`
    — stable partition: ids present in `catalog` keep relative order at the front; absent ids keep relative order at the back. Nothing removed.
  - `function intersects(candidates: string[], catalog: Set<string>): boolean`
    — true iff at least one candidate is in the catalog.
- Note: `loadCatalog` is added to this same file in Task 5.

- [ ] **Step 1: Write the failing test**

Create `src/catalog.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { reorder, intersects } from "./catalog.ts";

test("present ids move ahead of absent, relative order preserved", () => {
  const out = reorder(["a", "b", "c", "d"], new Set(["b", "d"]));
  assert.deepEqual(out, ["b", "d", "a", "c"]);
});

test("all-absent leaves the list complete and in order", () => {
  const out = reorder(["a", "b", "c"], new Set(["x"]));
  assert.deepEqual(out, ["a", "b", "c"]);
});

test("all-present returns the list unchanged", () => {
  const out = reorder(["a", "b"], new Set(["a", "b"]));
  assert.deepEqual(out, ["a", "b"]);
});

test("reorder never drops or adds ids", () => {
  const input = ["a", "b", "c"];
  const out = reorder(input, new Set(["b"]));
  assert.deepEqual([...out].sort(), [...input].sort());
});

test("intersects reports overlap", () => {
  assert.equal(intersects(["a", "b"], new Set(["b"])), true);
  assert.equal(intersects(["a", "b"], new Set(["x"])), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern 'present ids move ahead'`
Expected: FAIL — `Cannot find module './catalog.ts'`.

- [ ] **Step 3: Write the implementation**

Create `src/catalog.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern 'present|absent|unchanged|drops|intersects'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/catalog.ts src/catalog.test.ts
git commit -m "feat: pure stable-partition catalog reorder"
```

---

## Task 5: Catalog loader (cache + fetch)

**Files:**
- Modify: `src/catalog.ts` (add `loadCatalog` + `LoadCatalogOptions`)
- Modify: `src/catalog.test.ts` (add loader tests)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `interface LoadCatalogOptions { apiKey: string | undefined; ttlSeconds: number; cacheDir: string; fetchImpl?: typeof fetch; now?: number; warn?: (msg: string) => void }`
  - `async function loadCatalog(opts: LoadCatalogOptions): Promise<Set<string> | null>`
    — returns the catalog id set, or `null` for "no usable catalog" (missing key, fetch fail, empty/garbage). Uses a fresh on-disk cache (mtime within `ttlSeconds`) without a network call; otherwise fetches, persists atomically on success, never persists a bad response, and never uses a stale cache as a fallback. All non-fatal conditions emit one `warn`.

- [ ] **Step 1: Write the failing test**

Append to `src/catalog.test.ts`:

```ts
import { mkdtempSync, writeFileSync, statSync, utimesSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCatalog } from "./catalog.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "pykrete-cat-"));
}

function modelsResponse(ids: string[]): Response {
  return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });
}

test("missing API key -> null with a warning, no fetch", async () => {
  const warnings: string[] = [];
  let called = false;
  const out = await loadCatalog({
    apiKey: undefined,
    ttlSeconds: 3600,
    cacheDir: tmp(),
    fetchImpl: (async () => {
      called = true;
      return new Response("", { status: 200 });
    }) as typeof fetch,
    warn: (m) => warnings.push(m),
  });
  assert.equal(out, null);
  assert.equal(called, false);
  assert.equal(warnings.length, 1);
});

test("successful fetch returns ids and persists a cache file", async () => {
  const dir = tmp();
  const out = await loadCatalog({
    apiKey: "k",
    ttlSeconds: 3600,
    cacheDir: dir,
    fetchImpl: (async () => modelsResponse(["zai-org/glm-5.2", "TEE/deepseek-v4-pro:thinking"])) as typeof fetch,
  });
  assert.ok(out);
  assert.equal(out!.has("zai-org/glm-5.2"), true);
  const files = readdirSync(dir).filter((f) => f.startsWith("catalog-") && f.endsWith(".json"));
  assert.equal(files.length, 1);
});

test("fresh cache is used without a network call", async () => {
  const dir = tmp();
  // Seed: first call writes the cache.
  await loadCatalog({
    apiKey: "k",
    ttlSeconds: 3600,
    cacheDir: dir,
    now: 1_000_000,
    fetchImpl: (async () => modelsResponse(["a", "b"])) as typeof fetch,
  });
  // Second call within TTL must not fetch.
  let called = false;
  const out = await loadCatalog({
    apiKey: "k",
    ttlSeconds: 3600,
    cacheDir: dir,
    now: 1_000_500,
    fetchImpl: (async () => {
      called = true;
      return modelsResponse(["x"]);
    }) as typeof fetch,
  });
  assert.equal(called, false);
  assert.deepEqual([...out!].sort(), ["a", "b"]);
});

test("stale cache with a failing refetch returns null (no stale fallback)", async () => {
  const dir = tmp();
  // Seed a cache file, then age its mtime well past the TTL.
  const cacheFile = join(
    dir,
    readdirSync(dir).find((f) => f.startsWith("catalog-")) ??
      (await seedCache(dir)),
  );
  // seedCache returns the relative file name; rebuild absolute path:
  const abs = cacheFile;
  utimesSync(abs, 1000, 1000); // mtime = 1000s
  const out = await loadCatalog({
    apiKey: "k",
    ttlSeconds: 3600,
    cacheDir: dir,
    now: 100_000_000, // far past mtime + ttl
    fetchImpl: (async () => {
      throw new Error("network down");
    }) as typeof fetch,
  });
  assert.equal(out, null);
});

async function seedCache(dir: string): Promise<string> {
  await loadCatalog({
    apiKey: "k",
    ttlSeconds: 3600,
    cacheDir: dir,
    fetchImpl: (async () => modelsResponse(["a"])) as typeof fetch,
  });
  return readdirSync(dir).find((f) => f.startsWith("catalog-") && f.endsWith(".json"))!;
}

test("empty data response is not usable and is not persisted", async () => {
  const dir = tmp();
  const warnings: string[] = [];
  const out = await loadCatalog({
    apiKey: "k",
    ttlSeconds: 3600,
    cacheDir: dir,
    fetchImpl: (async () => modelsResponse([])) as typeof fetch,
    warn: (m) => warnings.push(m),
  });
  assert.equal(out, null);
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".json")).length, 0);
  assert.equal(warnings.length, 1);
});

test("non-2xx response returns null with a warning", async () => {
  const warnings: string[] = [];
  const out = await loadCatalog({
    apiKey: "k",
    ttlSeconds: 3600,
    cacheDir: tmp(),
    fetchImpl: (async () => new Response("nope", { status: 503 })) as typeof fetch,
    warn: (m) => warnings.push(m),
  });
  assert.equal(out, null);
  assert.equal(warnings.length, 1);
});

test("corrupt fresh cache falls through to a fetch", async () => {
  const dir = tmp();
  // Hand-write a corrupt cache file at the exact path loadCatalog will look for.
  const { createHash } = await import("node:crypto");
  const keyHash = createHash("sha256").update("k").digest("hex");
  const cacheFile = join(dir, `catalog-${keyHash}.json`);
  writeFileSync(cacheFile, "{ not json");
  utimesSync(cacheFile, 999, 999);
  const out = await loadCatalog({
    apiKey: "k",
    ttlSeconds: 3600,
    cacheDir: dir,
    now: 999 * 1000 + 100, // fresh by mtime
    fetchImpl: (async () => modelsResponse(["recovered"])) as typeof fetch,
  });
  assert.equal(out!.has("recovered"), true);
});
```

> Note: the `seedCache` helper in the "stale cache" test is referenced before its declaration via hoisting; if your linter objects, move the `async function seedCache` above that test. The intent is: seed a real cache file, age its mtime past TTL, confirm a failing refetch yields `null`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern 'missing API key'`
Expected: FAIL — `loadCatalog is not a function` (not yet exported).

- [ ] **Step 3: Write the implementation**

Append to `src/catalog.ts`:

```ts
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MODELS_URL = "https://nano-gpt.com/api/v1/models?detailed=true";

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
  try {
    mkdirSync(cacheDir, { recursive: true });
    const tmpFile = join(cacheDir, `catalog-${keyHash}.${process.pid}.${randomUUID()}.tmp`);
    writeFileSync(tmpFile, JSON.stringify([...ids]));
    renameSync(tmpFile, cacheFile);
  } catch {
    // cache write is non-essential; ignore
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern 'cache|API key|fetch|persist|data response'`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/catalog.ts src/catalog.test.ts
git commit -m "feat: advisory catalog loader with mtime cache and no stale fallback"
```

---

## Task 6: CLI wiring + executable

**Files:**
- Create: `src/cli.ts`, `src/cli.test.ts`, `bin/pykrete.ts`

**Interfaces:**
- Consumes: `loadConfig`/`ConfigError` (`./config.ts`), `resolveArgs`/`FamilyError` (`./args.ts`), `buildCandidates`/`Resolution` (`./resolve.ts`), `loadCatalog`/`reorder`/`intersects` (`./catalog.ts`).
- Produces:
  - `interface ParsedArgv { task?: string; family?: string; prompt?: string; configPath: string }`
  - `function parseArgv(argv: string[]): ParsedArgv`
  - `interface RunDeps { cacheDir?: string; apiKey?: string; fetchImpl?: typeof fetch; now?: number; warn?: (msg: string) => void }`
  - `interface RunResult extends Resolution { task: string; family: string; prompt?: string }`
  - `async function run(argv: string[], deps?: RunDeps): Promise<RunResult>`

- [ ] **Step 1: Write the failing test**

Create `src/cli.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgv, run } from "./cli.ts";

function writeConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), "pykrete-cli-"));
  const path = join(dir, "pykrete.toml");
  writeFileSync(
    path,
    [
      'default_family = "glm"',
      "[families]",
      'glm = ["zai-org/glm-5.2:thinking", "zai-org/glm-5.2", "zai-org/glm-5.1:thinking"]',
      "[defaults.code]",
      'glm = "zai-org/glm-5.2:thinking"',
    ].join("\n"),
  );
  return path;
}

function models(ids: string[]): typeof fetch {
  return (async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 })) as typeof fetch;
}

test("parseArgv extracts flags and the positional prompt", () => {
  const p = parseArgv(["--task", "code", "--family", "glm", "write", "a", "test"]);
  assert.equal(p.task, "code");
  assert.equal(p.family, "glm");
  assert.equal(p.prompt, "write a test");
  assert.equal(p.configPath, "pykrete.toml");
});

test("run resolves candidates with no catalog (no api key)", async () => {
  const config = writeConfig();
  const warnings: string[] = [];
  const r = await run(["--task", "code", "--family", "glm", "--config", config], {
    apiKey: undefined,
    cacheDir: mkdtempSync(join(tmpdir(), "pykrete-cache-")),
    warn: (m) => warnings.push(m),
  });
  assert.deepEqual(r.candidates, [
    "zai-org/glm-5.2:thinking",
    "zai-org/glm-5.2",
    "zai-org/glm-5.1:thinking",
  ]);
  assert.equal(r.intendedLead, "zai-org/glm-5.2:thinking");
  assert.ok(warnings.some((w) => /NANOGPT_API_KEY/.test(w)));
});

test("run applies catalog reorder when a catalog is available", async () => {
  const config = writeConfig();
  const r = await run(["--task", "code", "--family", "glm", "--config", config], {
    apiKey: "k",
    cacheDir: mkdtempSync(join(tmpdir(), "pykrete-cache-")),
    // Only the second-ranked id is "live" -> it moves to the front.
    fetchImpl: models(["zai-org/glm-5.2"]),
  });
  assert.equal(r.candidates[0], "zai-org/glm-5.2");
  // intendedLead is the PRE-reorder head, unchanged by catalog.
  assert.equal(r.intendedLead, "zai-org/glm-5.2:thinking");
});

test("run warns on zero catalog intersection but keeps the list intact", async () => {
  const config = writeConfig();
  const warnings: string[] = [];
  const r = await run(["--family", "glm", "--config", config], {
    apiKey: "k",
    cacheDir: mkdtempSync(join(tmpdir(), "pykrete-cache-")),
    fetchImpl: models(["something/unrelated"]),
    warn: (m) => warnings.push(m),
  });
  assert.equal(r.candidates.length, 3);
  assert.ok(warnings.some((w) => /matched none/.test(w)));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern 'parseArgv extracts'`
Expected: FAIL — `Cannot find module './cli.ts'`.

- [ ] **Step 3: Write the implementation**

Create `src/cli.ts`:

```ts
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { resolveArgs } from "./args.ts";
import { buildCandidates, type Resolution } from "./resolve.ts";
import { intersects, loadCatalog, reorder } from "./catalog.ts";

export interface ParsedArgv {
  task?: string;
  family?: string;
  prompt?: string;
  configPath: string;
}

export function parseArgv(argv: string[]): ParsedArgv {
  let task: string | undefined;
  let family: string | undefined;
  let configPath = "pykrete.toml";
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--task") task = argv[++i];
    else if (a === "--family") family = argv[++i];
    else if (a === "--config") configPath = argv[++i];
    else positionals.push(a);
  }
  return { task, family, prompt: positionals.length ? positionals.join(" ") : undefined, configPath };
}

export interface RunDeps {
  cacheDir?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  now?: number;
  warn?: (msg: string) => void;
}

export interface RunResult extends Resolution {
  task: string;
  family: string;
  prompt?: string;
}

export async function run(argv: string[], deps: RunDeps = {}): Promise<RunResult> {
  const warn = deps.warn ?? ((m: string) => console.error(m));
  const parsed = parseArgv(argv);

  const config = loadConfig(parsed.configPath);
  const { task, family, warnings } = resolveArgs(config, parsed.task, parsed.family);
  for (const w of warnings) warn(`pykrete: ${w}`);

  const { candidates, intendedLead } = buildCandidates(config, task, family);

  const cacheDir =
    deps.cacheDir ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "pykrete");
  const apiKey = deps.apiKey ?? process.env.NANOGPT_API_KEY;

  const catalog = await loadCatalog({
    apiKey,
    ttlSeconds: config.catalog.ttlSeconds,
    cacheDir,
    fetchImpl: deps.fetchImpl,
    now: deps.now,
    warn,
  });

  let ordered = candidates;
  if (catalog) {
    ordered = reorder(candidates, catalog);
    if (!intersects(candidates, catalog)) {
      warn(`pykrete: catalog matched none of family "${family}" candidates; ids may have drifted`);
    }
  }

  return { candidates: ordered, intendedLead, task, family, prompt: parsed.prompt };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern 'parseArgv|run resolves|run applies|run warns'`
Expected: PASS.

- [ ] **Step 5: Create the executable shim**

Create `bin/pykrete.ts`:

```ts
#!/usr/bin/env node
import { run } from "../src/cli.ts";
import { ConfigError } from "../src/config.ts";
import { FamilyError } from "../src/args.ts";

try {
  const result = await run(process.argv.slice(2));
  // Spec B consumes (candidates, intendedLead) and launches pi.
  // For Spec A, emit the resolved plan to stderr for inspection.
  console.error(`pykrete: intended_lead=${result.intendedLead}`);
  console.error(`pykrete: candidates=${result.candidates.join(", ")}`);
} catch (err) {
  if (err instanceof ConfigError || err instanceof FamilyError) {
    console.error(`pykrete: ${err.message}`);
    process.exit(2);
  }
  throw err;
}
```

- [ ] **Step 6: Smoke-test the executable end-to-end**

Create a throwaway config and run the bin:

```bash
cat > /tmp/pykrete-smoke.toml <<'EOF'
default_family = "glm"
[families]
glm = ["zai-org/glm-5.2:thinking", "zai-org/glm-5.2"]
[defaults.code]
glm = "zai-org/glm-5.2:thinking"
EOF
node --experimental-strip-types bin/pykrete.ts --task code --family glm --config /tmp/pykrete-smoke.toml "hello"
```

Expected (stderr; reorder may vary if `NANOGPT_API_KEY` is set and live):
```
pykrete: NANOGPT_API_KEY not set; skipping catalog reorder   # only if key unset
pykrete: intended_lead=zai-org/glm-5.2:thinking
pykrete: candidates=zai-org/glm-5.2:thinking, zai-org/glm-5.2
```

Then verify the family hard-error path:
```bash
node --experimental-strip-types bin/pykrete.ts --family bogus --config /tmp/pykrete-smoke.toml "hi"; echo "exit=$?"
```
Expected: `pykrete: unknown family "bogus"` then `exit=2`.

- [ ] **Step 7: Typecheck the whole project**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/cli.ts src/cli.test.ts bin/pykrete.ts
git commit -m "feat: CLI orchestration and pykrete executable (Spec A)"
```

---

## Self-Review (completed by plan author)

**Spec coverage** — every Spec A section maps to a task:

| Spec A requirement | Task |
|---|---|
| TOML schema + `ttl_seconds` default 3600 | 1 |
| Load-time lint (5 rules incl. bare-string + element-equality) | 1 |
| Pure `buildCandidates`, intent-precedence, dedup, `intendedLead` | 2 |
| `--task`/`--family` trim, unknown-task→general+warn, unknown-family hard error, case-sensitivity | 3 |
| Catalog stable-partition reorder + zero-intersection detection | 4 (+warn wired in 6) |
| Catalog fetch/cache: env key, sha256-keyed path, mtime TTL, atomic unique-temp write, no stale fallback, never-persist-bad, auth/network non-fatal | 5 |
| Errors table (family hard error, lint load error, no-usable-catalog warn) | 1, 3, 5, 6 |
| Observability stderr-only; `intendedLead` returned for Spec B | 5, 6 |
| CLI arg handling | 6 |
| Deferred/YAGNI items NOT built | (omitted by design) |

**Placeholder scan:** none — every code/test step carries full content; no TBD/"add error handling"/"similar to Task N".

**Type consistency:** `Config`, `Resolution`, `intendedLead`, `reorder`, `intersects`, `loadCatalog`, `LoadCatalogOptions`, `resolveArgs`, `ResolvedArgs`, `parseArgv`, `run`, `RunResult`, `RunDeps`, `ConfigError`, `FamilyError` are defined once and referenced consistently across tasks. `candidates[0]` is typed `string` (no `noUncheckedIndexedAccess`), and lint guarantees a non-empty family list so `intendedLead` is always defined.
