import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface NanogptProviderOptions {
  baseUrl?: string;
  apiKeyRef?: string;
}

export function buildModelsJson(candidates: string[], opts: NanogptProviderOptions = {}): unknown {
  return {
    providers: {
      nanogpt: {
        baseUrl: opts.baseUrl ?? "https://nano-gpt.com/api/v1",
        api: "openai-completions",
        apiKey: opts.apiKeyRef ?? "$NANOGPT_API_KEY",
        authHeader: true,
        models: candidates.map((id) => ({ id })),
      },
    },
  };
}

export interface RetrySettingsOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxRetryDelayMs?: number;
}

// Pin pi's native transient retry (same model, same session, backoff + Retry-After).
// Defaults match pi's documented defaults; overridable via [retry] in pykrete.toml (config.ts).
export function buildSettingsJson(opts: RetrySettingsOptions = {}): unknown {
  return {
    retry: {
      enabled: true,
      maxRetries: opts.maxRetries ?? 3,
      baseDelayMs: opts.baseDelayMs ?? 2000,
      provider: { maxRetryDelayMs: opts.maxRetryDelayMs ?? 60000 },
    },
  };
}

export interface AgentDir {
  dir: string;
  cleanup(): void;
}

export function createAgentDir(modelsJson: unknown, settingsJson: unknown): AgentDir {
  const dir = mkdtempSync(join(tmpdir(), "pykrete-agent-"));
  // createAgentDir is called before bin's try/finally, so a throw here leaks the dir (the caller
  // never gets a handle to cleanup()). Remove it ourselves if either write fails.
  try {
    writeFileSync(join(dir, "models.json"), JSON.stringify(modelsJson, null, 2));
    writeFileSync(join(dir, "settings.json"), JSON.stringify(settingsJson, null, 2));
  } catch (err) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    throw err;
  }
  return {
    dir,
    cleanup() {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort; a leaked temp dir is harmless
      }
    },
  };
}
