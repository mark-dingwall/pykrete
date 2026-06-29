import type { Config } from "./config.ts";

export interface Resolution {
  candidates: string[];
  intendedLead: string;
}

export function buildCandidates(config: Config, task: string, family: string): Resolution {
  const ranked = config.families[family];
  if (ranked === undefined) {
    throw new Error(`buildCandidates called with unvalidated family "${family}"`);
  }
  const taskPick = config.defaults[task]?.[family];
  const generalPick = config.defaults["general"]?.[family];

  const chain = [taskPick, generalPick, ...ranked].filter(
    (id): id is string => typeof id === "string",
  );

  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const id of chain) {
    if (!seen.has(id)) {
      seen.add(id);
      candidates.push(id);
    }
  }
  return { candidates, intendedLead: candidates[0] };
}
