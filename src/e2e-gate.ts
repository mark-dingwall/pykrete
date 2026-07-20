import { accessSync, constants, statSync } from "node:fs";

// Gate for the real-binary e2e tests. Unset PYKRETE_NEW_PI_BIN => the suite skips them, which is
// the normal offline `npm test`. Set but not executable => THROW, so a typo'd var value or a stale
// path fails loudly instead of silently skipping and letting a green suite read as "the upgrade was
// verified against the real binary" when nothing ran.
export function newPiBin(): string | undefined {
  const bin = process.env.PYKRETE_NEW_PI_BIN;
  if (bin === undefined) return undefined;
  try {
    // isFile() as well as X_OK: a directory is "executable" (searchable) to accessSync, so a
    // path typo landing on one would pass the gate and fail later as an opaque spawn error.
    if (!statSync(bin).isFile()) throw new Error("not a file");
    accessSync(bin, constants.X_OK);
  } catch {
    throw new Error(`PYKRETE_NEW_PI_BIN is ${JSON.stringify(bin)}, which is not an executable file`);
  }
  return bin;
}
