import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerFlatEdit from "../extensions/flat-edit.ts";

interface RegisteredFlatEdit {
  executionMode?: "sequential" | "parallel";
  execute(
    toolCallId: string,
    params: { path: string; oldText: string; newText: string },
    signal: AbortSignal,
    onUpdate: (update: unknown) => void,
    ctx: unknown,
  ): Promise<unknown>;
}

function registeredTool(): RegisteredFlatEdit {
  let registered: RegisteredFlatEdit | undefined;
  registerFlatEdit({
    registerTool(tool) {
      registered = tool;
    },
  });
  assert.ok(registered);
  return registered;
}

test("flat edit registers as sequential so pi serializes same-turn file mutations", () => {
  assert.equal(registeredTool().executionMode, "sequential");
});

test("flat edit matches LF arguments against a CRLF file and preserves CRLF output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pykrete-flat-edit-"));
  try {
    const target = join(dir, "target.txt");
    writeFileSync(target, "alpha\r\nbeta\r\ngamma\r\n");

    await registeredTool().execute(
      "call-1",
      { path: target, oldText: "alpha\nbeta", newText: "alpha\ninserted\nbeta" },
      new AbortController().signal,
      () => {},
      {},
    );

    assert.equal(readFileSync(target, "utf8"), "alpha\r\ninserted\r\nbeta\r\ngamma\r\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("flat edit preserves mixed line endings and carriage returns outside the replacement", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pykrete-flat-edit-"));
  try {
    const target = join(dir, "target.txt");
    writeFileSync(target, "head\nkeep\r\nliteral\rbyte\nold\r\n");

    await registeredTool().execute(
      "call-2",
      { path: target, oldText: "old", newText: "new" },
      new AbortController().signal,
      () => {},
      {},
    );

    assert.equal(readFileSync(target, "utf8"), "head\nkeep\r\nliteral\rbyte\nnew\r\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("flat edit prefers a unique raw match over a duplicate created by newline normalization", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pykrete-flat-edit-"));
  try {
    const target = join(dir, "target.txt");
    writeFileSync(target, "x\r\ny\n---\nx\ny\n");

    await registeredTool().execute(
      "call-3",
      { path: target, oldText: "x\r\ny", newText: "z" },
      new AbortController().signal,
      () => {},
      {},
    );

    assert.equal(readFileSync(target, "utf8"), "z\n---\nx\ny\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("flat edit uses the containing line ending for multiline replacements in a mixed file", async () => {
  const cases = [
    {
      before: "header\nsection\r\nold\r\ntail\r\n",
      after: "header\nsection\r\nnew\r\nline\r\ntail\r\n",
    },
    {
      before: "header\nsection\rold\rtail\r",
      after: "header\nsection\rnew\rline\rtail\r",
    },
  ];

  for (const { before, after } of cases) {
    const dir = mkdtempSync(join(tmpdir(), "pykrete-flat-edit-"));
    try {
      const target = join(dir, "target.txt");
      writeFileSync(target, before);

      await registeredTool().execute(
        "call-4",
        { path: target, oldText: "old", newText: "new\nline" },
        new AbortController().signal,
        () => {},
        {},
      );

      assert.equal(readFileSync(target, "utf8"), after);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("flat edit treats CRLF as indivisible when raw oldText splits the pair", async () => {
  const cases = [
    { oldText: "\nb", expected: "aZ" },
    { oldText: "a\r", expected: "Zb" },
  ];

  for (const { oldText, expected } of cases) {
    const dir = mkdtempSync(join(tmpdir(), "pykrete-flat-edit-"));
    try {
      const target = join(dir, "target.txt");
      writeFileSync(target, "a\r\nb");

      await registeredTool().execute(
        "call-5",
        { path: target, oldText, newText: "Z" },
        new AbortController().signal,
        () => {},
        {},
      );

      assert.equal(readFileSync(target, "utf8"), expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
