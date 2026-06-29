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
  assert.deepEqual(c.liveness, { nonceEnabled: true, idleTimeoutSeconds: 330, resumeAttempts: 1 });
});

test("liveness values are read and typed", () => {
  const c = parseConfig({ ...baseCfg, liveness: { nonce_enabled: false, idle_timeout_seconds: 90, resume_attempts: 2 } });
  assert.deepEqual(c.liveness, { nonceEnabled: false, idleTimeoutSeconds: 90, resumeAttempts: 2 });
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
