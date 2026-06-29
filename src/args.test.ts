import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config } from "./config.ts";
import { resolveArgs, FamilyError } from "./args.ts";

const cfg: Config = {
  defaultFamily: "glm",
  catalog: { ttlSeconds: 3600 },
  families: { glm: ["a"], kimi: ["b"] },
  defaults: { general: { glm: "a" }, code: { glm: "a" } },
  liveness: { nonceEnabled: true, idleTimeoutSeconds: 330, resumeAttempts: 1 },
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

test("inherited prototype name as family hard-errors, not crashes", () => {
  for (const name of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
    assert.throws(() => resolveArgs(cfg, undefined, name), FamilyError);
  }
});

test("inherited prototype name as task warns and normalizes to general", () => {
  const r = resolveArgs(cfg, "toString", "glm");
  assert.equal(r.task, "general");
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /toString/);
});

test("whitespace-only task normalizes to general without warning", () => {
  const r = resolveArgs(cfg, "  ", "glm");
  assert.equal(r.task, "general");
  assert.deepEqual(r.warnings, []);
});
