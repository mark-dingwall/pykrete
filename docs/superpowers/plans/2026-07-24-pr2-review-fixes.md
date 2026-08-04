# PR#2 Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the three verified Important findings and one Minor test-coverage gap from the multi-round review of PR#2 ("Expose watchdog timeouts and retry ladder in pykrete.toml"), without re-opening any settled finding from that review.

**Architecture:** All fixes live in `src/config.ts`'s `parseConfig` (add an upper bound to every new numeric field that reaches `setTimeout`, and one cross-field check comparing two already-parsed values), one comment correction in `pykrete.example.toml`, and one new behavioral test in `src/runCandidate.test.ts` that exercises a code path an existing test only appeared to cover.

**Tech Stack:** Node ≥22.18 native TypeScript, `node:test` + `node:assert/strict`, `smol-toml`. No new dependency.

## Global Constraints

- Touch only what each task requires — do not refactor the existing repetitive validation-block style in `config.ts` (that was reviewed and explicitly judged not a defect; a helper-function cleanup is out of scope here).
- Do not add an upper bound to `deadline_seconds` — it is compared arithmetically in `failover.ts` (`deadlineMs - elapsed <= 0`), never passed to `setTimeout`, so it is not subject to the overflow this plan fixes. Do not add one to `idle_timeout_seconds` either — that field predates this PR and its lack of an upper bound is a separate, already-accepted gap (CLAUDE.md notes the >300 floor is "backlogged"); expanding scope to it is a re-litigation of a settled item.
- Do not add an upper bound to `retry.base_delay_ms` / `retry.max_retry_delay_ms` / `retry.max_retries` — those three reach pi's own generated `settings.json` (via `buildSettingsJson`) and are consumed by the external `pi` binary, never by Pykrete's own `setTimeout`. Only fields that Pykrete itself hands to `setTimeout` are in scope: `startup_timeout_seconds`, `overall_timeout_seconds`, `kill_grace_seconds`, `probe_timeout_seconds` (all ×1000 in `bin/pykrete.ts`), and `outage_backoff_base_ms` / `outage_backoff_cap_ms` (raw ms, drive `deps.sleep()` in `runCandidate.ts`, which is `setTimeout` in the real `bin/pykrete.ts` wiring).
- Every new/changed `ConfigError` message must name the exact snake_case TOML key, matching the existing style in `src/config.ts`.
- Verify with `npm test && npm run typecheck` after each task, and again at the end.
- These findings came from reviewing already-pushed commit `b210b183030eefbbe2f501fd53fce18368f11e2f` (PR#2, branch `expose-timeout-retry-settings`). Make new commits on top of it — do not amend or rewrite that history.

---

### Task 1: Reject `outage_backoff_cap_ms` < `outage_backoff_base_ms`

**Why:** `runCandidate.ts`'s `gate()` does `let delay = backoffBaseMs; while (delay <= backoffCapMs) { ...sleep(delay)...; delay *= backoffFactor; }`. If the cap is below the base — both individually pass today's per-field validation — the loop body never runs, so `gate()` returns `giveup` after zero waits and zero re-probes on the very first outage. This silently disables the entire outage-tolerance mechanism the PR exposes as tunable. The check must compare the fully-resolved values (defaults applied), because an operator can trip this by setting only one of the two fields and leaving the other at its default.

**Files:**
- Modify: `src/config.ts:264-266` (end of the `retry` parsing block, before `return`)
- Test: `src/config.test.ts` (append after the existing `"[retry] must be a table"` test at the end of the file)

**Interfaces:**
- Consumes: `RetryConfig` (`src/config.ts:19-27`, already defined — no change), specifically `retry.outageBackoffBaseMs` and `retry.outageBackoffCapMs` after both are resolved (default-or-override) inside `parseConfig`.
- Produces: `parseConfig` now throws `ConfigError` for a previously-accepted invalid combination — no new exported symbols.

- [ ] **Step 1: Write the failing tests**

Append to `src/config.test.ts`:

```typescript
test("retry.outage_backoff_cap_ms must be >= outage_backoff_base_ms", () => {
  // Both explicit, cap below base.
  assert.throws(
    () => parseConfig({ ...baseCfg, retry: { outage_backoff_base_ms: 5000, outage_backoff_cap_ms: 1000 } }),
    ConfigError,
  );
  // Only base set, above the default cap (1_024_000) — must still be caught.
  assert.throws(
    () => parseConfig({ ...baseCfg, retry: { outage_backoff_base_ms: 2_000_000 } }),
    ConfigError,
  );
  // Only cap set, below the default base (1000) — must still be caught.
  assert.throws(
    () => parseConfig({ ...baseCfg, retry: { outage_backoff_cap_ms: 500 } }),
    ConfigError,
  );
  // Equal is the boundary case and must be accepted (loop runs exactly once).
  const c = parseConfig({ ...baseCfg, retry: { outage_backoff_base_ms: 1000, outage_backoff_cap_ms: 1000 } });
  assert.equal(c.retry.outageBackoffCapMs, 1000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern "outage_backoff_cap_ms must be"`
Expected: FAIL — the first three `assert.throws` calls fail because `parseConfig` does not yet throw for these inputs (no `ConfigError` is raised).

- [ ] **Step 3: Implement the cross-field check**

In `src/config.ts`, immediately before the final `return { defaultFamily, catalog: { ttlSeconds }, families, defaults, liveness, retry };` (currently line 266), insert:

```typescript
  // Cross-field: cap must be able to hold at least one ladder step, or gate() in runCandidate.ts
  // gives up on the first outage with zero backoff — silently disabling the whole mechanism.
  // Checked against the fully-resolved values so a lone override of either field is still caught.
  if (retry.outageBackoffCapMs < retry.outageBackoffBaseMs) {
    throw new ConfigError(
      "[retry].outage_backoff_cap_ms must be >= outage_backoff_base_ms (otherwise the backoff ladder never runs and a single outage blip gives up immediately)",
    );
  }

```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern "outage_backoff_cap_ms must be"`
Expected: PASS (all four assertions).

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all existing tests still pass (the shipped defaults `outageBackoffBaseMs: 1000` / `outageBackoffCapMs: 1_024_000` satisfy `cap >= base`, so no existing test input trips the new check), typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "fix: reject outage_backoff_cap_ms below outage_backoff_base_ms"
```

---

### Task 2: Reject timeout/backoff values that would overflow Node's `setTimeout` max delay

**Why:** `startup_timeout_seconds`, `overall_timeout_seconds`, `kill_grace_seconds`, `probe_timeout_seconds` (all ×1000 in `bin/pykrete.ts`) and `outage_backoff_base_ms` / `outage_backoff_cap_ms` (raw ms) all eventually reach a `setTimeout` call (`src/launch.ts`, `src/reachability.ts`, and `runCandidate.ts`'s injected `sleep`, which in the real `bin/pykrete.ts` wiring is `setTimeout`). Node treats any `setTimeout` delay outside `[1, 2147483647]` (~24.8 days) as `1` — it fires almost immediately instead of erroring. None of these six fields currently has an upper bound, so an operator who sets a huge value meaning "effectively unlimited" gets the opposite: the watchdog fires on spawn. `deadline_seconds` is correctly excluded (see Global Constraints) — do not touch it.

**Files:**
- Modify: `src/config.ts:169-203` (the four `[liveness]` checks) and `src/config.ts:236-256` (the two `[retry]` checks)
- Test: `src/config.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: two new module-level constants in `src/config.ts` — `MAX_SETTIMEOUT_MS = 2_147_483_647` and `MAX_SETTIMEOUT_SECONDS = 2_147_483` (`Math.floor(MAX_SETTIMEOUT_MS / 1000)`) — usable by any later task/file that needs the same bound (none currently does).

- [ ] **Step 1: Write the failing tests**

Append to `src/config.test.ts`:

```typescript
test("liveness timeout fields that feed setTimeout must not exceed Node's max delay (2147483647ms)", () => {
  const fields: [string, keyof Config["liveness"]][] = [
    ["startup_timeout_seconds", "startupTimeoutSeconds"],
    ["overall_timeout_seconds", "overallTimeoutSeconds"],
    ["kill_grace_seconds", "killGraceSeconds"],
    ["probe_timeout_seconds", "probeTimeoutSeconds"],
  ];
  for (const [snake, camel] of fields) {
    assert.throws(
      () => parseConfig({ ...baseCfg, liveness: { [snake]: 2_147_484 } }),
      ConfigError,
      `${snake} = 2_147_484 (over the max) should be rejected`,
    );
    const c = parseConfig({ ...baseCfg, liveness: { [snake]: 2_147_483 } });
    assert.equal(c.liveness[camel], 2_147_483, `${snake} = 2_147_483 (the max) should be accepted`);
  }
});

test("retry.outage_backoff_base_ms and outage_backoff_cap_ms must not exceed Node's max setTimeout delay", () => {
  assert.throws(
    () => parseConfig({ ...baseCfg, retry: { outage_backoff_base_ms: 2_147_483_648 } }),
    ConfigError,
  );
  assert.throws(
    () => parseConfig({ ...baseCfg, retry: { outage_backoff_cap_ms: 2_147_483_648 } }),
    ConfigError,
  );
  const c = parseConfig({
    ...baseCfg,
    retry: { outage_backoff_base_ms: 2_147_483_647, outage_backoff_cap_ms: 2_147_483_647 },
  });
  assert.equal(c.retry.outageBackoffCapMs, 2_147_483_647);
});
```

Note: `Config` must be importable as a type — it already is (`import { parseConfig, loadConfig, ConfigError, type Config } from "./config.ts";` at `src/config.test.ts:6`). No import change needed for this step.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern "must not exceed"`
Expected: FAIL — every `assert.throws` for an over-max value fails because `parseConfig` currently accepts it without error.

- [ ] **Step 3: Implement the bound constants and checks**

In `src/config.ts`, add the two constants directly after `DEFAULT_RETRY` (after line 69, before `export function parseConfig`):

```typescript
// Every field checked against these eventually reaches node:timers `setTimeout`, whose delay is a
// 32-bit signed int internally; Node clamps any value outside [1, 2147483647] down to ~1ms (fires
// almost immediately) instead of erroring. An operator setting a huge value to mean "effectively
// unlimited" would otherwise get the opposite. Reject anything that would silently invert intent.
const MAX_SETTIMEOUT_MS = 2_147_483_647;
const MAX_SETTIMEOUT_SECONDS = Math.floor(MAX_SETTIMEOUT_MS / 1000); // 2_147_483
```

Then update each of the four `[liveness]` checks to add the upper bound. Replace:

```typescript
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
```

with (note `deadline_seconds` is unchanged — copied verbatim — only the other three plus `startup_timeout_seconds` gain the bound):

```typescript
    if (l.startup_timeout_seconds !== undefined) {
      const v = l.startup_timeout_seconds;
      if (typeof v !== "number" || !Number.isInteger(v) || v <= 0 || v > MAX_SETTIMEOUT_SECONDS) {
        throw new ConfigError(
          `[liveness].startup_timeout_seconds must be a positive integer no greater than ${MAX_SETTIMEOUT_SECONDS} (Node's setTimeout max delay)`,
        );
      }
      liveness.startupTimeoutSeconds = v;
    }
    if (l.overall_timeout_seconds !== undefined) {
      const v = l.overall_timeout_seconds;
      if (typeof v !== "number" || !Number.isInteger(v) || v <= 0 || v > MAX_SETTIMEOUT_SECONDS) {
        throw new ConfigError(
          `[liveness].overall_timeout_seconds must be a positive integer no greater than ${MAX_SETTIMEOUT_SECONDS} (Node's setTimeout max delay)`,
        );
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
      if (typeof v !== "number" || !Number.isInteger(v) || v <= 0 || v > MAX_SETTIMEOUT_SECONDS) {
        throw new ConfigError(
          `[liveness].kill_grace_seconds must be a positive integer no greater than ${MAX_SETTIMEOUT_SECONDS} (Node's setTimeout max delay)`,
        );
      }
      liveness.killGraceSeconds = v;
    }
    if (l.probe_timeout_seconds !== undefined) {
      const v = l.probe_timeout_seconds;
      if (typeof v !== "number" || !Number.isInteger(v) || v <= 0 || v > MAX_SETTIMEOUT_SECONDS) {
        throw new ConfigError(
          `[liveness].probe_timeout_seconds must be a positive integer no greater than ${MAX_SETTIMEOUT_SECONDS} (Node's setTimeout max delay)`,
        );
      }
      liveness.probeTimeoutSeconds = v;
    }
```

Then update the two `[retry]` checks. Replace:

```typescript
    if (r.outage_backoff_base_ms !== undefined) {
      const v = r.outage_backoff_base_ms;
      if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
        throw new ConfigError("[retry].outage_backoff_base_ms must be a positive integer");
      }
      retry.outageBackoffBaseMs = v;
    }
```

with:

```typescript
    if (r.outage_backoff_base_ms !== undefined) {
      const v = r.outage_backoff_base_ms;
      if (typeof v !== "number" || !Number.isInteger(v) || v <= 0 || v > MAX_SETTIMEOUT_MS) {
        throw new ConfigError(
          `[retry].outage_backoff_base_ms must be a positive integer no greater than ${MAX_SETTIMEOUT_MS} (Node's setTimeout max delay)`,
        );
      }
      retry.outageBackoffBaseMs = v;
    }
```

And replace:

```typescript
    if (r.outage_backoff_cap_ms !== undefined) {
      const v = r.outage_backoff_cap_ms;
      if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
        throw new ConfigError("[retry].outage_backoff_cap_ms must be a positive integer");
      }
      retry.outageBackoffCapMs = v;
    }
```

with:

```typescript
    if (r.outage_backoff_cap_ms !== undefined) {
      const v = r.outage_backoff_cap_ms;
      if (typeof v !== "number" || !Number.isInteger(v) || v <= 0 || v > MAX_SETTIMEOUT_MS) {
        throw new ConfigError(
          `[retry].outage_backoff_cap_ms must be a positive integer no greater than ${MAX_SETTIMEOUT_MS} (Node's setTimeout max delay)`,
        );
      }
      retry.outageBackoffCapMs = v;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern "must not exceed"`
Expected: PASS (both new tests, all assertions).

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all existing tests still pass (every existing test uses values far below `2_147_483` seconds / `2_147_483_647` ms), typecheck clean. Also re-run Task 1's test to confirm the two changes compose: `npm test -- --test-name-pattern "outage_backoff_cap_ms must be"`.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "fix: reject timeout/backoff values that would overflow setTimeout's max delay"
```

---

### Task 3: Correct the `deadline_seconds` sizing comment in `pykrete.example.toml`

**Why:** The comment says a family needs up to `N x overall_timeout_seconds`. `src/config.ts`'s own comment (`src/config.ts:44-46`, unchanged by this plan) documents the true worst case per candidate as `(resumeAttempts+1) x overallTimeoutSeconds`, because the deadline is enforced *between* candidates (`failover.ts:36-38`) but not within one candidate's resume loop. The example's formula omits that factor — with the shipped default `resume_attempts=1` it undercounts by 2x, actively contradicting the codebase's own documented worst case rather than merely being imprecise. Doc-only change, no code, no test.

**Files:**
- Modify: `pykrete.example.toml:54-58`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing (comment only).

- [ ] **Step 1: Fix the comment**

In `pykrete.example.toml`, replace:

```toml
# Hard cap on the whole failover run, across every candidate. Time spent paused waiting out a
# NanoGPT outage does not count against this. A family with N candidates can legitimately need up
# to N x overall_timeout_seconds, so raise this if you also raise overall_timeout_seconds or add
# candidates to a family.
deadline_seconds = 3600
```

with:

```toml
# Hard cap on the whole failover run, across every candidate. Time spent paused waiting out a
# NanoGPT outage does not count against this. The deadline is checked BETWEEN candidates, not
# within one, so a single candidate's resume loop can consume up to (resume_attempts+1) x
# overall_timeout_seconds. A family with N candidates can legitimately need up to
# N x (resume_attempts+1) x overall_timeout_seconds — raise this if you raise overall_timeout_seconds,
# resume_attempts, or add candidates to a family.
deadline_seconds = 3600
```

- [ ] **Step 2: Verify the file still parses**

Run: `node --experimental-strip-types -e "const { parse } = require('smol-toml'); const fs = require('fs'); parse(fs.readFileSync('pykrete.example.toml', 'utf-8')); console.log('OK')"`
Expected: prints `OK` (a comment-only change cannot break TOML parsing, but this confirms no stray syntax was introduced).

- [ ] **Step 3: Commit**

```bash
git add pykrete.example.toml
git commit -m "docs: correct deadline_seconds sizing formula to include resume_attempts"
```

---

### Task 4: Add a test that actually exercises the `maxOutageRetries` override

**Why:** The existing "ctx backoff overrides replace the default ladder and cap" test (`src/runCandidate.test.ts`, added by PR#2) sets `maxOutageRetries: 1` in its context, but its scripted scenario has `probe` always return `"down"`. That means `gate()`'s own base/factor/cap ladder (`while (delay <= backoffCapMs)`) exhausts and returns `giveup` *before* `retrySameCandidateAfterOutage` — the function that actually checks `++outageRetries > maxOutageRetries` — is ever called. The wiring itself is correct (`runCandidate.ts:54` resolves `ctx.maxOutageRetries ?? MAX_OUTAGE_RETRIES`, and `:111` checks it), but no test proves that specific override changes behavior: if the override were silently dropped and `MAX_OUTAGE_RETRIES` (10) were used regardless, every existing test would still pass. This task adds one that would fail under that regression.

**Files:**
- Modify: `src/runCandidate.test.ts` (append after the existing `"a flapping network (down/up forever) terminates at MAX_OUTAGE_RETRIES with transient"` test)

**Interfaces:**
- Consumes: `runCandidate` (`src/runCandidate.ts`, signature unchanged: `(ctx: CandidateContext, deps: RunCandidateDeps) => Promise<CandidateResult>`), the file's existing `ctx`, `baseDeps`, `outcome` test helpers (`src/runCandidate.test.ts:9-41`, unchanged).
- Produces: nothing new — test-only addition.

- [ ] **Step 1: Write the test**

In `src/runCandidate.test.ts`, immediately after the existing test block:

```typescript
test("a flapping network (down/up forever) terminates at MAX_OUTAGE_RETRIES with transient", async () => {
  // Idle every attempt; probe recovers each time -> retrySameCandidateAfterOutage relaunches without
  // spending resume budget. Bounded by MAX_OUTAGE_RETRIES so it cannot loop forever.
  const probe = (() => { let i = 0; return () => Promise.resolve<Reachability>(i++ % 2 === 0 ? "down" : "up"); })();
  const launch: RunCandidateDeps["launch"] = () => Promise.resolve(outcome({}, { idledOut: true })); // pre-output idle, no session
  const r = await runCandidate(ctx, baseDeps({ launch, probe, sleep: () => Promise.resolve() }));
  assert.equal(r.kind, "transient"); // gave up after MAX_OUTAGE_RETRIES
});
```

add:

```typescript
test("ctx.maxOutageRetries override bounds the outage-retry loop itself, not just the backoff ladder", async () => {
  // Unlike "ctx backoff overrides replace the default ladder and cap" (which uses an always-"down"
  // probe, so gate()'s own ladder exhausts first), this drives probe recovery every cycle so
  // retrySameCandidateAfterOutage's own `++outageRetries > maxOutageRetries` check is what
  // terminates the loop. If the override were silently dropped (falling back to the default
  // MAX_OUTAGE_RETRIES = 10), this would run 11 launches instead of 3 and the assertion would fail.
  let launches = 0;
  const launch: RunCandidateDeps["launch"] = () => {
    launches += 1;
    return Promise.resolve(outcome({}, { idledOut: true })); // pre-output idle, no session -> always retries fresh
  };
  const probe = (() => { let i = 0; return () => Promise.resolve<Reachability>(i++ % 2 === 0 ? "down" : "up"); })();
  const r = await runCandidate(
    { ...ctx, maxOutageRetries: 2 },
    baseDeps({ launch, probe, sleep: () => Promise.resolve() }),
  );
  assert.equal(r.kind, "transient");
  assert.equal(launches, 3); // initial launch + 2 retries, then the 3rd recovery exceeds maxOutageRetries=2
});
```

- [ ] **Step 2: Run the test to verify it passes against the current (correct) implementation**

Run: `npm test -- --test-name-pattern "bounds the outage-retry loop itself"`
Expected: PASS. (This test documents and pins existing correct behavior rather than driving a code change — there is no "make it fail first" step because `runCandidate.ts` is not being modified in this task. To confirm the test is not vacuous, do Step 3.)

- [ ] **Step 3: Confirm the test can fail — temporarily break the wiring and re-run**

Temporarily edit `src/runCandidate.ts` line 54 from:
```typescript
  const maxOutageRetries = ctx.maxOutageRetries ?? MAX_OUTAGE_RETRIES;
```
to:
```typescript
  const maxOutageRetries = MAX_OUTAGE_RETRIES;
```
Run: `npm test -- --test-name-pattern "bounds the outage-retry loop itself"`
Expected: FAIL (`launches` would be 11, not 3), proving the test actually exercises the override.
Then revert the temporary edit exactly back to `const maxOutageRetries = ctx.maxOutageRetries ?? MAX_OUTAGE_RETRIES;` and re-run to confirm PASS again.

- [ ] **Step 4: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/runCandidate.test.ts
git commit -m "test: pin ctx.maxOutageRetries override with a scenario that actually exercises it"
```

---

### Task 5: Final full verification

**Why:** Confirm the four fixes compose cleanly and nothing in the broader suite regressed, matching this repo's standard verification bar (per `CLAUDE.md`).

**Files:** none (verification only).

**Interfaces:** none.

- [ ] **Step 1: Run the full unit suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests pass (the pre-existing 189-passed/6-skipped baseline from PR#2, plus the 2 new tests from Task 1, the 2 new tests from Task 2, and the 1 new test from Task 4 — 6 net new passing tests), typecheck clean.

- [ ] **Step 2: Confirm no unrelated files changed**

Run: `git diff --stat b210b183030eefbbe2f501fd53fce18368f11e2f..HEAD`
Expected: only `src/config.ts`, `src/config.test.ts`, `pykrete.example.toml`, and `src/runCandidate.test.ts` appear.

(The e2e suite — `PYKRETE_NEW_PI_BIN=$(readlink -f "$(which pi)") npm run test:e2e` — is optional here: none of these four tasks touch classify, launch, agentdir, or the event accumulator's runtime behavior against a real `pi` binary; they only add validation to already-unit-tested config parsing and one already-unit-tested `runCandidate` code path. Run it anyway if `NANOGPT_API_KEY` is available and you want extra confidence before pushing.)
