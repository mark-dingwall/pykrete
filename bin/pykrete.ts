#!/usr/bin/env node
import { mkdtempSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.ts";
import { ConfigError } from "../src/config.ts";
import { FamilyError } from "../src/args.ts";
import { buildModelsJson, buildSettingsJson, createAgentDir } from "../src/agentdir.ts";
import { launchAttempt, type HeartbeatInfo } from "../src/launch.ts";
import { runFailover } from "../src/failover.ts";
import { runCandidate } from "../src/runCandidate.ts";
import { probeNanoGpt } from "../src/reachability.ts";

// Opt-in liveness for programmatic callers; off by default so interactive use stays quiet.
function heartbeatMsFromEnv(): number | undefined {
  const raw = process.env.PYKRETE_HEARTBEAT_SECONDS;
  if (raw === undefined || raw === "") return undefined;
  const secs = Number(raw);
  return Number.isFinite(secs) && secs > 0 ? secs * 1000 : undefined;
}

function emitHeartbeat(info: HeartbeatInfo): void {
  console.error(
    JSON.stringify({
      pykrete: "heartbeat",
      candidate: info.candidate,
      elapsed_s: Math.round(info.elapsedMs / 1000),
      events: info.events,
      idle_s: Math.round(info.idleMs / 1000),
    }),
  );
}

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<number> {
  // An empty shell export counts as "existing" to loadEnvFile and would silently block a valid
  // .env value below, then fail with a misleading "not set" message. Treat empty as absent. Must
  // precede loadEnvFile(): it treats an already-present (even empty) shell value as set and won't
  // overwrite it from .env.
  if (process.env.NANOGPT_API_KEY === "") delete process.env.NANOGPT_API_KEY;
  const preEnvKeys = new Set(Object.keys(process.env));
  try {
    process.loadEnvFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`pykrete: failed to load .env: ${(err as Error).message}`);
      return 2;
    }
    // no .env in cwd; NANOGPT_API_KEY must already be exported
  }
  // .env may only supply NANOGPT_API_KEY; strip any other var it introduced so a .env
  // cannot widen the trust surface (e.g. PYKRETE_PI_BIN) or disable PYKRETE_SKIP_KEY_PREFLIGHT.
  for (const key of Object.keys(process.env)) {
    if (key !== "NANOGPT_API_KEY" && !preEnvKeys.has(key)) delete process.env[key];
  }
  if (!process.env.PYKRETE_SKIP_KEY_PREFLIGHT && !process.env.NANOGPT_API_KEY) {
    console.error("pykrete: NANOGPT_API_KEY is not set (checked the environment and .env)");
    return 2;
  }

  let resolved;
  try {
    resolved = await run(process.argv.slice(2));
  } catch (err) {
    if (err instanceof ConfigError || err instanceof FamilyError) {
      console.error(`pykrete: ${err.message}`);
      return 2;
    }
    throw err;
  }

  let prompt = resolved.prompt;
  if (prompt === "-" || (prompt === undefined && !process.stdin.isTTY)) {
    const raw = await readStream(process.stdin);
    // Gate presence on the trimmed value (pi trims too) but forward raw: a whitespace-only stdin
    // becomes a clean exit 2 rather than a silent no-op where pi runs with an empty prompt.
    prompt = raw.trim() === "" ? undefined : raw;
  }
  if (prompt === undefined) {
    console.error("pykrete: no prompt provided");
    return 2;
  }

  const apiKey = process.env.NANOGPT_API_KEY;
  const heartbeatMs = heartbeatMsFromEnv();
  const liveness = resolved.liveness;
  const retry = resolved.retry;
  const agent = createAgentDir(buildModelsJson(resolved.candidates), buildSettingsJson(retry));
  const sessionRoot = mkdtempSync(join(tmpdir(), "pykrete-sess-"));
  try {
    const result = await runFailover(
      { candidates: resolved.candidates, intendedLead: resolved.intendedLead, prompt },
      {
        runCandidate: (candidate) => {
          const sessionDir = join(sessionRoot, encodeURIComponent(candidate));
          mkdirSync(sessionDir, { recursive: true });
          return runCandidate(
            {
              prompt,
              nonceEnabled: liveness.nonceEnabled,
              resumeAttempts: liveness.resumeAttempts,
              backoffBaseMs: retry.outageBackoffBaseMs,
              backoffFactor: retry.outageBackoffFactor,
              backoffCapMs: retry.outageBackoffCapMs,
              maxOutageRetries: retry.maxOutageRetries,
            },
            {
              launch: (req) =>
                launchAttempt({
                  candidate,
                  prompt: req.prompt,
                  agentDir: agent.dir,
                  apiKey,
                  startupTimeoutMs: liveness.startupTimeoutSeconds * 1000,
                  overallTimeoutMs: liveness.overallTimeoutSeconds * 1000,
                  idleTimeoutMs: liveness.idleTimeoutSeconds * 1000,
                  killGraceMs: liveness.killGraceSeconds * 1000,
                  sessionDir,
                  continueSession: req.continueSession,
                  heartbeatMs,
                  heartbeat: heartbeatMs ? emitHeartbeat : undefined,
                }),
              probe: () =>
                probeNanoGpt({
                  fetchImpl: fetch,
                  apiKey,
                  url: process.env.PYKRETE_MODELS_URL,
                  timeoutMs: liveness.probeTimeoutSeconds * 1000,
                }),
              sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
              // Resumable state = pi wrote a session transcript (a .jsonl), not merely that Pykrete's
              // own mkdirSync left the dir non-empty (D7). pi's --continue also filters candidate
              // sessions by EXACT resolved-cwd equality, so the resume MUST run from the same cwd as the
              // first attempt — bin spawns pi from a single stable cwd, satisfying this; do not change
              // cwd between a candidate's attempts (Task 0 Step 2 asserts context actually survives).
              sessionReady: () => {
                try {
                  return readdirSync(sessionDir).some((f) => f.endsWith(".jsonl"));
                } catch {
                  return false;
                }
              },
              warn: (m) => console.error(m),
            },
          );
        },
        now: Date.now,
        warn: (m) => console.error(m),
        emit: (text) => process.stdout.write(text.endsWith("\n") ? text : `${text}\n`),
        deadlineMs: liveness.deadlineSeconds * 1000,
      },
    );
    return result.exitCode;
  } finally {
    // Remove the session root first (best-effort) so a throw from agent.cleanup() cannot leak it.
    try {
      rmSync(sessionRoot, { recursive: true, force: true });
    } catch {
      // best-effort; a leaked temp dir is harmless
    }
    agent.cleanup();
  }
}

process.exitCode = await main();
