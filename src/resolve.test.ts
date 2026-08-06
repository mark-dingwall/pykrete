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
  liveness: {
    nonceEnabled: true,
    idleTimeoutSeconds: 330,
    resumeAttempts: 1,
    startupTimeoutSeconds: 180,
    overallTimeoutSeconds: 1800,
    deadlineSeconds: 3600,
    killGraceSeconds: 5,
    probeTimeoutSeconds: 4,
  },
  retry: {
    maxRetries: 3,
    baseDelayMs: 2000,
    maxRetryDelayMs: 60000,
    outageBackoffBaseMs: 1000,
    outageBackoffFactor: 2,
    outageBackoffCapMs: 1_024_000,
    maxOutageRetries: 10,
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
