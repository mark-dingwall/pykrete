import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { ConfigError } from "./config.ts";

export interface PathOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  cwd?: string;
  cwdFn?: () => string;
  statSync?: (path: string) => unknown;
}

export function xdgConfigHome(options: PathOptions = {}): string {
  const env = options.env ?? process.env;
  const configured = env.XDG_CONFIG_HOME;
  if (configured && isAbsolute(configured)) return configured;
  const fallbackHome = options.homeDir ?? homedir();
  if (!isAbsolute(fallbackHome)) {
    throw new ConfigError(`cannot resolve global config: expected an absolute home directory, got ${JSON.stringify(fallbackHome)}`);
  }
  return join(fallbackHome, ".config");
}

export function globalConfigPath(options: PathOptions = {}): string {
  return join(xdgConfigHome(options), "pykrete", "pykrete.toml");
}

export function globalCredentialsPath(options: PathOptions = {}): string {
  return join(xdgConfigHome(options), "pykrete", "credentials.env");
}

export function resolveConfigPath(
  cliPath: string | undefined,
  options: PathOptions = {},
): string {
  if (cliPath !== undefined) return cliPath;

  const env = options.env ?? process.env;
  if (env.PYKRETE_CONFIG) return env.PYKRETE_CONFIG;

  let cwd = options.cwd;
  if (cwd === undefined) {
    try {
      cwd = options.cwdFn ? options.cwdFn() : process.cwd();
    } catch (err) {
      throw new ConfigError(`cannot resolve working directory: ${(err as Error).message}`);
    }
  }

  const localPath = join(cwd, "pykrete.toml");
  try {
    (options.statSync ?? statSync)(localPath);
    return localPath;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ConfigError(`cannot inspect local config at ${localPath}: ${(err as Error).message}`);
    }
  }

  return globalConfigPath(options);
}
