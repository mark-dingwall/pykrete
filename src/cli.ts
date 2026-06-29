import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, type LivenessConfig } from "./config.ts";
import { resolveArgs } from "./args.ts";
import { buildCandidates, type Resolution } from "./resolve.ts";
import { intersects, loadCatalog, reorder } from "./catalog.ts";

export interface ParsedArgv {
  task?: string;
  family?: string;
  prompt?: string;
  configPath: string;
}

export function parseArgv(argv: string[]): ParsedArgv {
  let task: string | undefined;
  let family: string | undefined;
  let configPath = "pykrete.toml";
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--task") task = argv[++i];
    else if (a === "--family") family = argv[++i];
    else if (a === "--config") configPath = argv[++i];
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
}

export async function run(argv: string[], deps: RunDeps = {}): Promise<RunResult> {
  const warn = deps.warn ?? ((m: string) => console.error(m));
  const parsed = parseArgv(argv);

  const config = loadConfig(parsed.configPath);
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
  return { candidates: ordered, intendedLead, task, family, prompt: parsed.prompt, liveness: config.liveness };
}
