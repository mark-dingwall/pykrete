import type { Config } from "./config.ts";

export class FamilyError extends Error {}

export interface ResolvedArgs {
  task: string;
  family: string;
  warnings: string[];
}

export function resolveArgs(
  config: Config,
  rawTask: string | undefined,
  rawFamily: string | undefined,
): ResolvedArgs {
  const warnings: string[] = [];

  let family: string;
  if (rawFamily === undefined) {
    family = config.defaultFamily;
  } else {
    family = rawFamily.trim();
    if (!Object.hasOwn(config.families, family)) {
      throw new FamilyError(`unknown family "${family}"`);
    }
  }

  let task = (rawTask ?? "general").trim();
  if (task === "") task = "general";
  if (task !== "general" && !Object.hasOwn(config.defaults, task)) {
    warnings.push(`unknown task "${task}", using "general"`);
    task = "general";
  }

  return { task, family, warnings };
}
