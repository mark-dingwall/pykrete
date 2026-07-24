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

test("fractional ttl_seconds is rejected", () => {
  const frac = clone();
  frac.catalog.ttl_seconds = 3600.5;
  assert.throws(() => parseConfig(frac), ConfigError);
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

test("defaults membership is element equality, not substring", () => {
  // Family has only "zai-org/glm-5.2:thinking".
  // Default is "zai-org/glm-5.2" — a strict substring but NOT an element.
  const raw = {
    default_family: "glm",
    families: { glm: ["zai-org/glm-5.2:thinking"] },
    defaults: { code: { glm: "zai-org/glm-5.2" } },
  };
  assert.throws(() => parseConfig(raw), ConfigError);
});

test("loadConfig with malformed TOML throws ConfigError", () => {
  const dir = mkdtempSync(join(tmpdir(), "pykrete-"));
  const path = join(dir, "bad.toml");
  writeFileSync(path, "[families\n"); // unterminated table header
  assert.throws(() => loadConfig(path), ConfigError);
});

const baseCfg = { default_family: "glm", families: { glm: ["a"] } };

test("liveness defaults when [liveness] omitted", () => {
  const c = parseConfig(baseCfg);
  assert.deepEqual(c.liveness, {
    nonceEnabled: true,
    idleTimeoutSeconds: 330,
    resumeAttempts: 1,
    startupTimeoutSeconds: 180,
    overallTimeoutSeconds: 1800,
    deadlineSeconds: 3600,
    killGraceSeconds: 5,
    probeTimeoutSeconds: 4,
  });
});

test("liveness values are read and typed", () => {
  const c = parseConfig({
    ...baseCfg,
    liveness: {
      nonce_enabled: false,
      idle_timeout_seconds: 90,
      resume_attempts: 2,
      startup_timeout_seconds: 60,
      overall_timeout_seconds: 900,
      deadline_seconds: 1800,
      kill_grace_seconds: 10,
      probe_timeout_seconds: 8,
    },
  });
  assert.deepEqual(c.liveness, {
    nonceEnabled: false,
    idleTimeoutSeconds: 90,
    resumeAttempts: 2,
    startupTimeoutSeconds: 60,
    overallTimeoutSeconds: 900,
    deadlineSeconds: 1800,
    killGraceSeconds: 10,
    probeTimeoutSeconds: 8,
  });
});

test("liveness.idle_timeout_seconds must be a positive integer", () => {
  assert.throws(() => parseConfig({ ...baseCfg, liveness: { idle_timeout_seconds: 0 } }), ConfigError);
});

test("liveness.resume_attempts may be 0 but not negative", () => {
  assert.equal(parseConfig({ ...baseCfg, liveness: { resume_attempts: 0 } }).liveness.resumeAttempts, 0);
  assert.throws(() => parseConfig({ ...baseCfg, liveness: { resume_attempts: -1 } }), ConfigError);
});

test("liveness.nonce_enabled must be a boolean", () => {
  assert.throws(() => parseConfig({ ...baseCfg, liveness: { nonce_enabled: "yes" } }), ConfigError);
});

test("liveness.startup_timeout_seconds, overall_timeout_seconds, deadline_seconds, kill_grace_seconds, probe_timeout_seconds must be positive integers", () => {
  for (const key of [
    "startup_timeout_seconds",
    "overall_timeout_seconds",
    "deadline_seconds",
    "kill_grace_seconds",
    "probe_timeout_seconds",
  ]) {
    assert.throws(() => parseConfig({ ...baseCfg, liveness: { [key]: 0 } }), ConfigError, `${key} = 0 should be rejected`);
    assert.throws(() => parseConfig({ ...baseCfg, liveness: { [key]: 1.5 } }), ConfigError, `${key} = 1.5 should be rejected`);
  }
});

test("retry defaults when [retry] omitted", () => {
  const c = parseConfig(baseCfg);
  assert.deepEqual(c.retry, {
    maxRetries: 3,
    baseDelayMs: 2000,
    maxRetryDelayMs: 60000,
    outageBackoffBaseMs: 1000,
    outageBackoffFactor: 2,
    outageBackoffCapMs: 1_024_000,
    maxOutageRetries: 10,
  });
});

test("retry values are read and typed", () => {
  const c = parseConfig({
    ...baseCfg,
    retry: {
      max_retries: 5,
      base_delay_ms: 500,
      max_retry_delay_ms: 30000,
      outage_backoff_base_ms: 2000,
      outage_backoff_factor: 3,
      outage_backoff_cap_ms: 512000,
      max_outage_retries: 4,
    },
  });
  assert.deepEqual(c.retry, {
    maxRetries: 5,
    baseDelayMs: 500,
    maxRetryDelayMs: 30000,
    outageBackoffBaseMs: 2000,
    outageBackoffFactor: 3,
    outageBackoffCapMs: 512000,
    maxOutageRetries: 4,
  });
});

test("retry.max_retries and retry.max_outage_retries may be 0 but not negative", () => {
  assert.equal(parseConfig({ ...baseCfg, retry: { max_retries: 0 } }).retry.maxRetries, 0);
  assert.throws(() => parseConfig({ ...baseCfg, retry: { max_retries: -1 } }), ConfigError);
  assert.equal(parseConfig({ ...baseCfg, retry: { max_outage_retries: 0 } }).retry.maxOutageRetries, 0);
  assert.throws(() => parseConfig({ ...baseCfg, retry: { max_outage_retries: -1 } }), ConfigError);
});

test("retry.outage_backoff_factor must be greater than 1", () => {
  assert.throws(() => parseConfig({ ...baseCfg, retry: { outage_backoff_factor: 1 } }), ConfigError);
  assert.throws(() => parseConfig({ ...baseCfg, retry: { outage_backoff_factor: 0.5 } }), ConfigError);
  assert.equal(parseConfig({ ...baseCfg, retry: { outage_backoff_factor: 1.5 } }).retry.outageBackoffFactor, 1.5);
});

test("[retry] must be a table", () => {
  assert.throws(() => parseConfig({ ...baseCfg, retry: "nope" }), ConfigError);
});

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
