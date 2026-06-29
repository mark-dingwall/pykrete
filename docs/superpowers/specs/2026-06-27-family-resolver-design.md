# Pykrete family resolver — design (Spec A)

**Date:** 2026-06-27 (v3: 2026-06-29 — split at the pi seam; catalog is advisory-only)
**Status:** Awaiting review (v3)
**Companion:** Spec B — launcher/failover (`2026-06-29-launcher-failover-design.md`), blocked on the pi error-surface investigation.

## Problem

NanoGPT model ids churn fast — our shortlist moved under every family within two weeks
(Kimi 2.6 → 2.7, GLM 5.1 → 5.2, MiniMax M3 → M2.7). Pinning exact ids means constant
cat-and-mouse. We address models by **family** and resolve to an ordered list of concrete
ids at call time.

Per Contract 06-05, Pykrete is transport wiring: the caller passes a prompt + optional
arguments (`--task`, `--family`) and gets reliable inference, never knowing transport
internals. The caller *declares* a task type; Pykrete must NOT infer or decompose tasks.
**Reliability is the prime goal — nothing in the resolution path may stop a run.**

## Scope

This spec (A) covers the pi-independent half:
- TOML config schema (`pykrete.toml`): families, per-task defaults, default family, catalog settings.
- Argument handling for `--task` / `--family`.
- The **resolver**: a pure function producing an ordered candidate list for `(task, family)`.
- The **catalog client**: fetch/cache of the NanoGPT model list, used **only** to advisorily
  re-order candidates. It can never drop a candidate or stop a run.
- Load-time lint, resolution-path errors, observability for the above.

Out of scope:
- **Launch / failover** — consuming the candidate list, trying ids in order, classifying pi
  errors, the substitution exit code, child stream handling. That is **Spec B**, which depends
  on inspecting the current pi error surface (the provider-layer refactor changed it).
- Per-model compat flags, `flat-edit.ts`, concurrency semaphore, sentinel nonce, dataHarvesting
  warning — `.research/DECISION.md` (Branch A); they wrap each launch attempt (Spec B territory).
- Task decomposition, verdict gates, plan→execute handoff (future orchestration project).

## Output contract

`resolve(...)` returns an **ordered, deduped list of candidate model ids** within the chosen
family (best-first), plus the **intended lead** — the pre-reorder `candidates[0]`, i.e. the id
we would launch if every model were live. Spec B uses the intended lead as the substitution
baseline (launched id ≠ intended lead ⇒ downgrade). The intended lead is always defined (the
list is never empty) and uniformly covers the task-default, general-driven, and family-list-only
cases — unlike a task-only pick, which is `None` whenever the order is driven by the general
default. The resolver never returns a single id and never errors on catalog state. Durability
comes from Spec B trying the list in order; this spec just produces a good order.

## Config schema (`pykrete.toml`)

```toml
default_family = "glm"

[catalog]
ttl_seconds = 3600   # cache lifetime for the /models snapshot (optional; default 3600)

[families]                            # single source of truth: ranked id lists, best first
glm      = ["zai-org/glm-5.2:thinking", "zai-org/glm-5.2", "zai-org/glm-5.1:thinking"]
kimi     = ["moonshotai/kimi-k2.6:thinking", "moonshotai/kimi-k2.7-code", "moonshotai/kimi-k2.5:thinking"]
deepseek = ["TEE/deepseek-v4-pro:thinking", "deepseek/deepseek-v3.2:thinking"]

[defaults.general]                    # per task -> per family chosen variant
glm  = "zai-org/glm-5.2"
kimi = "moonshotai/kimi-k2.6:thinking"

[defaults.code]
glm  = "zai-org/glm-5.2:thinking"
kimi = "moonshotai/kimi-k2.7-code"
```

- `[families]`: each value is a **non-empty list of strings**, ranked best-first. **Single source of truth.**
- `[defaults.<task>].<family>`: preferred variant for that `(task, family)`; every id MUST be a
  member of its family's list (lint-enforced, by element equality).
- `default_family`: used when `--family` is omitted.
- `[catalog].ttl_seconds`: optional, default 3600.
- Ids are matched **exactly** against the catalog. Suffixes (`:thinking`) and prefixes (`TEE/`)
  are first-class catalog ids and are NOT normalized/stripped. Example ids verified present
  2026-06-29.
- A family may appear in `[families]` with no `[defaults]` entry; `--task` is then a no-op for
  it (resolves straight from the ranked list). Intentional.

## Resolution (pure function)

`build_candidates(config, task, family) -> ([model_id], intended_lead)`. Pure, no network.
Assumes `family` already validated against `[families]`. Steps:

1. Concatenate, dropping anything missing (tolerant `.get` on possibly-absent tables/entries):
   ```
   [ defaults.get(task, {}).get(family),       # task pick   (most specific intent)
     defaults.get("general", {}).get(family),   # general pick (next intent)
     *families[family] ]                        # ranked family list (quality order)
   ```
2. Dedup, keeping first occurrence.

This **intent-precedence** order (task ▸ general ▸ ranked) falls out of the concatenation;
there is no configurable knob. Because lint guarantees every default id is an element of its
family list, the result is always a non-empty permutation/subset of `families[family]`.
`intended_lead` = `candidates[0]` (the intent-precedence winner, before any catalog reorder).

Worked example — `--task code --family glm`:
`[glm-5.2:thinking(code), glm-5.2(general), glm-5.2:thinking, glm-5.2, glm-5.1:thinking]`
→ dedup → `[glm-5.2:thinking, glm-5.2, glm-5.1:thinking]`.

## Catalog client — advisory ordering ONLY

Purpose: nudge known-dead ids to the back so Spec B tries likely-live ids first. It can never
drop a candidate, never error, never stop a run.

- **Source:** the authed `GET https://nano-gpt.com/api/v1/models?detailed=true` id set (the
  "what this account can route to" view; a strict subset of the no-auth catalog).
- **API key:** from env `NANOGPT_API_KEY`. If absent/empty → skip the fetch, no reordering,
  emit one stderr warning. Not an error.
- **Cache:** on disk at `${XDG_CACHE_HOME:-~/.cache}/pykrete/catalog-<keyhash>.json`, keyed by a
  hash of the API key (different keys never share a view). Freshness is judged by the cache
  file's **mtime**; within `ttl_seconds` of mtime the cache is used without a network call.
  Writes are atomic: a **uniquely-named** temp file (pid + nonce) **in the same directory**, then
  rename. A parse failure, a non-2xx response, or an **empty** id set is treated as "no usable
  catalog" (no reorder) and is **never persisted** (so a blip can't poison a good cache).
- **No stale fallback:** a past-TTL cache whose refetch fails is treated as "no usable catalog"
  (no reorder), not used as a fallback ordering source. Deliberate: stale ordering is only
  marginally useful and never run-affecting, so simplicity wins.
- **Reordering rule:** if a usable catalog is available, apply a **stable** partition to the
  candidate list — ids present in the catalog keep their relative order at the front; ids absent
  from the catalog keep their relative order at the back. Nothing is removed. If no usable
  catalog is available, the list is returned unchanged.
- **Zero-intersection warning:** if a *usable* catalog intersects **none** of the family's
  candidate ids, emit a stderr warning. This silent no-op otherwise looks identical to a healthy
  reorder and is the early signal that upstream ids drifted (a `:thinking`/prefix rename) or the
  config went stale — exactly the churn this project exists to absorb.
- **Auth/network failures are not fatal:** a 401/403/5xx/timeout on `/models` just means "no
  usable catalog" → no reorder + warn. Genuine inference-auth failures surface later at launch
  (Spec B), not here.

Consequence: there is **no** catalog-driven "family dead" error and **no** force-refetch. A truly
retired family simply has all its candidates sorted to the back and is caught by failover
exhaustion in Spec B. One possibly-wasted launch on a known-dead lead is the only cost.

## Lint (load time)

- Each `[families].<family>` value is a **non-empty list of strings**. (Catches a bare string,
  which would otherwise pass a naive membership check and be spread into characters.)
- Every `[defaults.<task>].<family>` id is an **element** (equality, not substring) of
  `[families].<family>`. → single-source-of-truth.
- Every family referenced in any `[defaults.<task>]` exists in `[families]`.
- `default_family` exists in `[families]`.
- `[defaults.general]` is **not** required (family-list-only families are legal).
- `[catalog].ttl_seconds`, if present, is a positive integer.
  - *Known limitation:* a TOML float that is integer-valued (`3600.0`) collapses to a JS integer
    in the parser before lint sees it, so it passes the integer check. A genuinely fractional
    value (`3600.5`) is still rejected. Harmless — ttl is advisory only — so not worth a
    pre-parse type guard.

## Errors (resolution path)

| Condition | Behaviour |
|---|---|
| `--family` not in `[families]` (after trim) | Hard error (unknown family), at the CLI before resolution |
| Any lint rule violated | Load error naming the offending key |
| No usable catalog (key absent, fetch failed, empty/garbage) | Warn on stderr, proceed with un-reordered list |

(There is deliberately no run-stopping error in this spec. "Family unavailable" is a launch-time
verdict in Spec B.)

## Observability

- The resolver/catalog layer writes **only to stderr**; stdout belongs to the run result (Spec B).
- stderr warnings: unknown `--task` normalized to `general`; no-usable-catalog (key missing /
  fetch failed / empty); usable-catalog-zero-intersection (id drift).
- The returned `intended_lead` lets Spec B emit the substitution signal (and its exit code) — that
  logic lives in Spec B.

## CLI (argument handling portion)

```
pykrete [--task <type>] [--family <name>] "prompt"
```

- Both optional → `default_family` + `general`.
- `--task`: trimmed; matched case-sensitively; unknown to config → normalized to `general` with
  a stderr warning (forward-compatible for unconfigured tasks).
- `--family`: trimmed; matched case-sensitively; not in `[families]` → hard error.
- (The prompt and the actual pi launch are handled in Spec B.)

## Control flow (Spec A portion)

1. Load + lint `pykrete.toml` (fail fast on lint errors).
2. Parse args: resolve `task` (normalize unknown → general, warn), resolve `family`
   (default if omitted; hard error if unknown).
3. `build_candidates(config, task, family)` → ordered list + `intended_lead` (= `candidates[0]`).
4. Load catalog (cache-within-TTL else fetch; advisory; never fatal).
5. If a usable catalog exists, stable-partition the list (present-first, absent-to-back); warn on zero intersection.
6. Hand `(ordered_list, intended_lead)` to the launcher (Spec B).

## Testing

Resolver (pure, fixture-driven `(config, task, family) → (list, intended_lead)`):
- `task=code, family=glm` → `[code pick, general pick, …ranked…]`, deduped; `intended_lead` == list head.
- Unknown task → resolves as `general` (and warns); `intended_lead` == general pick.
- Dedup: task pick == general pick == a ranked id → appears once, order preserved.
- Family with no defaults → list == ranked family list, `intended_lead` == `families[family][0]`, `--task` ignored.
- `--family` omitted → `default_family`; `--family` overrides.

Catalog ordering (injected catalog states):
- Usable catalog with some ids absent → absent ids moved to back, relative order otherwise preserved; nothing removed. `intended_lead` is the **pre-reorder** head (unchanged by reordering).
- Usable catalog with all family ids absent → all sorted to back, list still complete (no error).
- Usable catalog intersecting **zero** candidates → list unchanged + zero-intersection warning emitted.
- No key / fetch fails / empty response → list unchanged, warning emitted, nothing persisted.
- Past-TTL cache + refetch fails → treated as no usable catalog (no reorder), stale snapshot not used.
- Cache within TTL (by mtime) is used without a network call; cache keyed by auth identity (two keys ≠ shared).
- Atomic write via unique temp in cache dir; corrupt cache file treated as a miss.

Lint:
- `[families].x` as a bare string → load error.
- `defaults` id absent from its family list (element equality) → load error.
- `default_family` absent from `[families]` → load error.
- Family referenced in `[defaults]` absent from `[families]` → load error.
- `[catalog].ttl_seconds = 0` / negative → load error.

CLI:
- `--family` unknown → hard error; `--family " glm "` → trimmed, resolves; `--family GLM` → hard error (case).

## Deferred (YAGNI for v1)

- Single-flight de-duplication of concurrent catalog refetches.
- Lint against duplicate ids within a family list (runtime dedup neutralizes them).
- A configurable intent-vs-quality ordering knob (committed to intent-precedence).
