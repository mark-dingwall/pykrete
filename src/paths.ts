import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface PathOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  cwd?: string;
  existsSync?: (path: string) => boolean;
}

export function xdgConfigHome(options: PathOptions = {}): string {
  const env = options.env ?? process.env;
  const configured = env.XDG_CONFIG_HOME;
  if (configured && isAbsolute(configured)) return configured;
  return join(options.homeDir ?? homedir(), ".config");
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

  const localPath = join(options.cwd ?? process.cwd(), "pykrete.toml");
  if ((options.existsSync ?? existsSync)(localPath)) return localPath;

  return globalConfigPath(options);
}
