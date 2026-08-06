import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PACKAGE_JSON = fileURLToPath(new URL("../package.json", import.meta.url));

test("flat-edit's runtime TypeBox import is installed in production", () => {
  const manifest = JSON.parse(readFileSync(PACKAGE_JSON, "utf8"));

  assert.equal(manifest.dependencies?.typebox, "1.1.38");
});
