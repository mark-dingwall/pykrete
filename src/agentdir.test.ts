import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildModelsJson, buildSettingsJson, createAgentDir } from "./agentdir.ts";

test("buildModelsJson registers all candidates under a nanogpt openai-completions provider", () => {
  const json = buildModelsJson(["a/b", "c/d"]) as {
    providers: { nanogpt: { baseUrl: string; api: string; apiKey: string; authHeader: boolean; models: { id: string }[] } };
  };
  const p = json.providers.nanogpt;
  assert.equal(p.baseUrl, "https://nano-gpt.com/api/v1");
  assert.equal(p.api, "openai-completions");
  assert.equal(p.apiKey, "$NANOGPT_API_KEY");
  assert.equal(p.authHeader, true);
  assert.deepEqual(p.models, [{ id: "a/b" }, { id: "c/d" }]);
});

test("buildModelsJson honours baseUrl and apiKeyRef overrides", () => {
  const json = buildModelsJson(["x"], { baseUrl: "http://local/v1", apiKeyRef: "$OTHER" }) as {
    providers: { nanogpt: { baseUrl: string; apiKey: string } };
  };
  assert.equal(json.providers.nanogpt.baseUrl, "http://local/v1");
  assert.equal(json.providers.nanogpt.apiKey, "$OTHER");
});

test("buildSettingsJson pins pi native same-model transient retry on", () => {
  const json = buildSettingsJson() as { retry: { enabled: boolean; maxRetries: number; baseDelayMs: number; provider: { maxRetryDelayMs: number } } };
  assert.equal(json.retry.enabled, true);
  assert.equal(json.retry.maxRetries, 3);
  assert.equal(json.retry.baseDelayMs, 2000);
  assert.equal(json.retry.provider.maxRetryDelayMs, 60000);
});

test("buildSettingsJson honours retry overrides", () => {
  const json = buildSettingsJson({ maxRetries: 5, baseDelayMs: 500, maxRetryDelayMs: 30000 }) as {
    retry: { maxRetries: number; baseDelayMs: number; provider: { maxRetryDelayMs: number } };
  };
  assert.equal(json.retry.maxRetries, 5);
  assert.equal(json.retry.baseDelayMs, 500);
  assert.equal(json.retry.provider.maxRetryDelayMs, 30000);
});

test("createAgentDir writes models.json + settings.json and cleanup removes the dir", () => {
  const models = buildModelsJson(["a/b"]);
  const settings = buildSettingsJson();
  const agent = createAgentDir(models, settings);
  assert.deepEqual(JSON.parse(readFileSync(join(agent.dir, "models.json"), "utf-8")), models);
  assert.deepEqual(JSON.parse(readFileSync(join(agent.dir, "settings.json"), "utf-8")), settings);
  agent.cleanup();
  assert.ok(!existsSync(agent.dir));
});

// ---------------------------------------------------------------------------
// Upgrade-survival guards: assert every key Pykrete emits is one new-pi's config
// schema still accepts, and that Pykrete emits none of the keys new-pi removed/
// renamed. These are structural guards (Pykrete can't import pi's TypeBox schema
// — no dependency), transcribed from pi origin/main source. The real ground-truth
// check is the env-gated e2e in config.e2e.test.ts.
//
// Provider keys accepted by ProviderConfigSchema (all Type.Optional):
//   pi packages/coding-agent/src/core/model-config.ts, ProviderConfigSchema
//   -> name, baseUrl, apiKey, api, oauth, headers, compat, authHeader, models, modelOverrides
const PROVIDER_SCHEMA_KEYS = new Set([
  "name",
  "baseUrl",
  "apiKey",
  "api",
  "oauth",
  "headers",
  "compat",
  "authHeader",
  "models",
  "modelOverrides",
]);
// Model keys accepted by ModelDefinitionSchema (id required; rest Type.Optional):
//   same file, ModelDefinitionSchema
//   -> id, name, api, baseUrl, reasoning, thinkingLevelMap, input, cost,
//      contextWindow, maxTokens, samplingParams, headers, compat
const MODEL_SCHEMA_KEYS = new Set([
  "id",
  "name",
  "api",
  "baseUrl",
  "reasoning",
  "thinkingLevelMap",
  "input",
  "cost",
  "contextWindow",
  "maxTokens",
  "samplingParams",
  "headers",
  "compat",
]);

// Recursively collect every object key appearing anywhere in a value.
function allKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const el of value) allKeys(el, into);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      allKeys(v, into);
    }
  }
  return into;
}

test("buildModelsJson emits only provider/model keys new-pi's ProviderConfigSchema/ModelDefinitionSchema accept", () => {
  const json = buildModelsJson(["a/b", "c/d"]) as {
    providers: Record<string, Record<string, unknown> & { models: Array<Record<string, unknown>> }>;
  };
  const provider = json.providers.nanogpt;

  // Every top-level provider key must be in the schema's allowed set. Fails if
  // buildModelsJson starts emitting an unknown/removed/renamed provider key.
  for (const key of Object.keys(provider)) {
    assert.ok(
      PROVIDER_SCHEMA_KEYS.has(key),
      `buildModelsJson emits provider key "${key}" not accepted by pi ProviderConfigSchema (model-config.ts)`,
    );
  }

  // Every model-definition key must be in the schema's allowed set.
  for (const model of provider.models) {
    for (const key of Object.keys(model)) {
      assert.ok(
        MODEL_SCHEMA_KEYS.has(key),
        `buildModelsJson emits model key "${key}" not accepted by pi ModelDefinitionSchema (model-config.ts)`,
      );
    }
    assert.ok("id" in model, "each model must carry the required 'id' key (ModelDefinitionSchema)");
  }

  // Breaking change: compat.sendSessionIdHeader was removed in favour of
  // compat.sessionAffinityFormat (model-config.ts, OpenAICompletionsCompatSchema).
  // Pykrete must never emit it, anywhere in the tree.
  assert.ok(!allKeys(json).has("sendSessionIdHeader"), "models.json must not emit removed key 'sendSessionIdHeader'");
});

test("buildSettingsJson emits only new-pi RetrySettings keys, not legacy retry.maxDelayMs", () => {
  // RetrySettings = { enabled?, maxRetries?, baseDelayMs?, provider? }
  // ProviderRetrySettings = { timeoutMs?, maxRetries?, maxRetryDelayMs? }
  //   pi packages/coding-agent/src/core/settings-manager.ts, RetrySettings/ProviderRetrySettings
  const RETRY_KEYS = new Set(["enabled", "maxRetries", "baseDelayMs", "provider"]);
  const PROVIDER_RETRY_KEYS = new Set(["timeoutMs", "maxRetries", "maxRetryDelayMs"]);

  const json = buildSettingsJson() as { retry: Record<string, unknown> & { provider?: Record<string, unknown> } };
  for (const key of Object.keys(json.retry)) {
    assert.ok(RETRY_KEYS.has(key), `buildSettingsJson emits retry key "${key}" not in new-pi RetrySettings (settings-manager.ts)`);
  }
  for (const key of Object.keys(json.retry.provider ?? {})) {
    assert.ok(
      PROVIDER_RETRY_KEYS.has(key),
      `buildSettingsJson emits retry.provider key "${key}" not in new-pi ProviderRetrySettings (settings-manager.ts)`,
    );
  }
  // The legacy key retry.maxDelayMs was renamed to retry.provider.maxRetryDelayMs
  // (migrated + deleted in settings-manager.ts migrateSettings). Pykrete already
  // uses the new key; it must not regress to the legacy one.
  assert.ok(!allKeys(json).has("maxDelayMs"), "settings.json must not emit legacy 'maxDelayMs'");
});

test("createAgentDir removes its temp dir if a write fails", () => {
  const countDirs = () => readdirSync(tmpdir()).filter((n) => n.startsWith("pykrete-agent-")).length;
  const before = countDirs();
  const circular: Record<string, unknown> = {};
  circular.self = circular; // JSON.stringify throws after mkdtemp -> must self-clean
  assert.throws(() => createAgentDir(circular, buildSettingsJson()));
  assert.equal(countDirs(), before, "leaked a temp dir on write failure");
});
