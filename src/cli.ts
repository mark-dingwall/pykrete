import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig, type LivenessConfig, type RetryConfig } from "./config.ts";
import { resolveArgs } from "./args.ts";
import { buildCandidates, type Resolution } from "./resolve.ts";
import { intersects, loadCatalog, reorder } from "./catalog.ts";
import { resolveConfigPath } from "./paths.ts";

export const HELP = `Usage: pykrete [--task <task>] [--family <family>] [--config <path>] [--help] "<prompt>"

A headless launcher that wires the \`pi\` coding agent to NanoGPT as its sole inference
provider. You hand it a prompt; it picks a model, runs the agent, and gets out of the way.

Arguments:
  "<prompt>"        Prompt text. A positional argument, "-" to read stdin, or piped
                    stdin. Always sent to pi via stdin, never argv (avoids E2BIG on
                    large prompts).

Options:
  --task <task>      Select the family's lead model from [defaults.<task>].
                    Default: "general".
  --family <family>  Select a candidate chain from [families].
                    Default: the \`default_family\` in pykrete.toml.
  --config <path>    Path to pykrete.toml. Default: PYKRETE_CONFIG, then
                    pykrete.toml in the cwd, then the XDG user config.
  -h, --help         Show this help and exit 0.

Exit codes (frozen): {0, 3} success, {1, 2, 4} failure.
  0  Success on the intended lead model.
  3  Success on a substituted model after failover (warning to stderr).
  1  Run error -- fatal, transient, or died after producing output.
  2  Usage error -- bad config, unknown family, missing prompt, or missing API key.
  4  Every candidate was unavailable.

Environment:
  NANOGPT_API_KEY             Required. From the shell env or a .env file in the cwd
                              or XDG user credentials (first non-empty value wins).
  PYKRETE_CONFIG              Default config path when --config is omitted.
  PYKRETE_PI_BIN              Override the pi binary (default: pi on PATH).
  PYKRETE_HEARTBEAT_SECONDS   Emit periodic JSON progress lines to stderr.
  PYKRETE_MODELS_URL          Test seam for the catalog endpoint. Unset = production.
  PYKRETE_SKIP_KEY_PREFLIGHT  Test seam to bypass the NANOGPT_API_KEY preflight.

See pykrete.example.toml for full configuration documentation.
`;

export function wantsHelp(argv: string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

export interface ParsedArgv {
  task?: string;
  family?: string;
  prompt?: string;
  configPath?: string;
}

export function parseArgv(argv: string[]): ParsedArgv {
  let task: string | undefined;
  let family: string | undefined;
  let configPath: string | undefined;
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--task" || a === "--family" || a === "--config") {
      const value = argv[++i];
      if (value === undefined) throw new ConfigError(`${a} requires a value`);
      if (a === "--task") task = value;
      else if (a === "--family") family = value;
      else configPath = value;
    }
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
  liveness: LivenessConfig;
  retry: RetryConfig;
}

export async function run(argv: string[], deps: RunDeps = {}): Promise<RunResult> {
  const warn = deps.warn ?? ((m: string) => console.error(m));
  const parsed = parseArgv(argv);

  const config = loadConfig(resolveConfigPath(parsed.configPath));
  const { task, family, warnings } = resolveArgs(config, parsed.task, parsed.family);
  for (const w of warnings) warn(`pykrete: ${w}`);

  const { candidates, intendedLead } = buildCandidates(config, task, family);

  const cacheDir =
    deps.cacheDir ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "pykrete");
  const apiKey = "apiKey" in deps ? deps.apiKey : process.env.NANOGPT_API_KEY;

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

  // D1/Q3: idle_timeout_seconds should exceed pi's 300s HTTP idle window (default 330). A lower value
  // may false-kill a slow-but-alive stream; warn but allow it (an operator may have lowered pi's own
  // httpIdleTimeout to match).
  if (config.liveness.idleTimeoutSeconds <= 300) {
    warn(`pykrete: idle_timeout_seconds=${config.liveness.idleTimeoutSeconds} is within pi's 300s HTTP idle window; slow-but-alive streams may be killed early`);
  }
  return { candidates: ordered, intendedLead, task, family, prompt: parsed.prompt, liveness: config.liveness, retry: config.retry };
}
