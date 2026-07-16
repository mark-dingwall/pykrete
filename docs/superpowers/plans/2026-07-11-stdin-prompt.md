# Stdin Prompt Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let pykrete accept its prompt on stdin (via the `-` sentinel or an omitted arg while stdin is not a TTY) and deliver prompts of any size to the `pi` subprocess without hitting Linux `MAX_ARG_STRLEN`/`E2BIG`.

**Architecture:** The prompt reaches the model over two process hops, both on argv today. **Hop 2** (`pykrete → pi`, `src/launch.ts`) switches from passing the prompt as pi's last argv element to writing it to pi's **stdin** — pi reads a piped, non-TTY stdin as the prompt under `--mode json`. **Hop 1** (`multi-review → pykrete`, `bin/pykrete.ts`) reads pykrete's own stdin into a string when the positional arg is `-` (or omitted + non-TTY), then that one buffered string is re-emitted to every pi spawn (fresh, resume, failover) through the single Hop-2 write.

**Tech Stack:** Node ≥22.18 native TypeScript (`--experimental-strip-types`), ESM, `node:test` + `node:assert/strict`, `node:child_process` `spawn`/`spawnSync`. No external dependencies.

## Global Constraints

- Runtime: Node `>=22.18`, run via `node --experimental-strip-types`; `"type": "module"` (ESM). Copy no new deps.
- Test runner: `node:test`. Full suite: `npm test` → `node --experimental-strip-types --test 'src/**/*.test.ts'`. Typecheck: `npm run typecheck` → `tsc --noEmit`.
- **Prompt goes on stdin, never argv** — this is the whole point; it must never appear in a child's `/proc/PID/cmdline`.
- Exit-code contract is FROZEN: `{0,3}` = success, `{1,2,4}` = failure. Do **not** touch `src/failover.ts` or the classify/verdict path.
- pi is invoked with `-p --mode json --offline --provider nanogpt --model <id>` (+ optional `--session-dir`, `--continue`). `--mode json` ⇒ `appMode !== "rpc"` ⇒ pi reads stdin as the prompt (JSON-RPC stdin framing is gated on `appMode === "rpc"`, which pykrete never sets). Verified in `~/pi/packages/coding-agent/src/main.ts` and `.../src/cli/initial-message.ts`.
- pi calls `.trim()` on its stdin. Harmless: review prompts have no significant edge whitespace, and the liveness nonce is interior text matched on pi's *output*, not its input.

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `src/launch.ts` | Spawns pi, owns the child's stdio | Modify: prompt → pi stdin (Hop 2) |
| `bin/pykrete.ts` | Process entry; resolves the prompt | Modify: read own stdin on `-`/omitted (Hop 1) |
| `src/test-fixtures/fake-pi.mjs` | pi stand-in for tests | Modify: read prompt from stdin; add `echostdin`/`echolen` |
| `src/launch.test.ts` | Unit tests for `launchAttempt` | Modify: assert prompt delivered via stdin |
| `src/bin.test.ts` | End-to-end binary tests | Modify: stdin acceptance tests + exit-2 guard |

No new files. `src/cli.ts` (`parseArgv`) is unchanged — a bare `-` already parses to `prompt === "-"` and an omitted arg to `prompt === undefined`.

---

### Task 1: Deliver the prompt to pi on stdin (Hop 2)

Switch the `pi` spawn from prompt-on-argv to prompt-on-stdin, and update the pi stand-in fixture to read its prompt from stdin. This alone eliminates `E2BIG` at the `pykrete → pi` hop and keeps the whole suite green (existing bin nonce/resume tests still pass because the fixture now reads stdin).

**Files:**
- Modify: `src/launch.ts` (the `launchAttempt` spawn, currently lines ~47–54)
- Modify: `src/test-fixtures/fake-pi.mjs`
- Test: `src/launch.test.ts`

**Interfaces:**
- Consumes: `launchAttempt(opts: LaunchOptions)` — `opts.prompt: string` is the exact text for this attempt (already carries the nonce suffix for fresh launches / the resume prompt for resumes; built in `src/runCandidate.ts:66,69`). Unchanged signature.
- Produces: the fixture gains two scenarios selected by `--model` substring — `echostdin` (emits its stdin verbatim as assistant text) and `echolen` (emits `LEN <n>` where n is the piped stdin's JS string length — `.length`, i.e. UTF-16 code units, which equals the byte count for the ASCII test payloads). Task 2 reuses `echolen`.

- [ ] **Step 1: Write the failing tests**

Add to `src/launch.test.ts` (after the existing `base()` helper and tests):

```ts
test("prompt is delivered to pi on stdin, not argv", async () => {
  const r = await launchAttempt({ ...base("echostdin"), prompt: "HELLO-STDIN" });
  assert.equal(r.outcome.text, "HELLO-STDIN");
});

test("a >128 KiB prompt is delivered whole via stdin (no E2BIG)", async () => {
  const big = "x".repeat(200_000); // over Linux MAX_ARG_STRLEN (131072)
  const r = await launchAttempt({ ...base("echolen"), prompt: big });
  assert.equal(r.outcome.text, `LEN ${big.length}`);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-strip-types --test src/launch.test.ts`
Expected: the two new tests FAIL — `echostdin`/`echolen` are unknown models, so `fake-pi.mjs` falls to its default branch and returns `"RESULT-OK"`, not the piped prompt.

- [ ] **Step 3: Update the fixture to read the prompt from stdin**

In `src/test-fixtures/fake-pi.mjs`, add a lazy stdin reader immediately after the `argv`/`model` parsing block (after line 8). Read stdin **only** inside branches that need the prompt — do NOT add a top-level `await`, or the `stall`/`hang`/`deaf` scenarios would depend on the parent closing stdin:

```js
async function readStdin() {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const c of process.stdin) data += c;
  return data;
}
```

Change the `nonceok` branch (currently line 42) from `const prompt = argv[argv.length - 1] ?? "";` to:

```js
} else if (model.includes("nonceok")) {
  const prompt = await readStdin();
  const nonce = (/WORK COMPLETE ([0-9a-f]{16})/.exec(prompt) ?? [])[1] ?? "";
  emit({ type: "agent_start" });
  assistant({ content: [{ type: "text", text: `RESULT-OK\nWORK COMPLETE ${nonce}` }], stopReason: "stop" });
  emit({ type: "agent_end" });
```

Change the `resume2step` **resume** branch (the `else` at currently line 57–64) `const prompt = argv[argv.length - 1] ?? "";` to `const prompt = await readStdin();`:

```js
  } else {
    // Resume: now emit the nonce carried in the resume prompt and complete.
    const prompt = await readStdin();
    const nonce = (/WORK COMPLETE ([0-9a-f]{16})/.exec(prompt) ?? [])[1] ?? "";
    emit({ type: "agent_start" });
    assistant({ content: [{ type: "text", text: `RESULT-OK\nWORK COMPLETE ${nonce}` }], stopReason: "stop" });
    emit({ type: "agent_end" });
  }
```

Add two new scenarios just before the final `else` (after the `resume2step` block, before line 65's `} else {`):

```js
} else if (model.includes("echostdin")) {
  const prompt = await readStdin();
  emit({ type: "agent_start" });
  assistant({ content: [{ type: "text", text: prompt }], stopReason: "stop" });
  emit({ type: "agent_end" });
} else if (model.includes("echolen")) {
  const prompt = await readStdin();
  emit({ type: "agent_start" });
  assistant({ content: [{ type: "text", text: `LEN ${prompt.length}` }], stopReason: "stop" });
  emit({ type: "agent_end" });
```

Leave `dumpargs`, `stall`, `hang`, `deaf`, `idlepost`, the error scenarios, and the `resume2step` attempt-1 branch untouched — they never read the prompt.

- [ ] **Step 4: Change the spawn to pipe the prompt to pi's stdin**

In `src/launch.ts`, replace the argv-push + spawn (currently lines 47–54):

```ts
  const args = ["-p", "--mode", "json", "--offline", "--provider", "nanogpt", "--model", opts.candidate];
  if (opts.sessionDir !== undefined) args.push("--session-dir", opts.sessionDir);
  if (opts.continueSession) args.push("--continue");
  args.push(opts.prompt);
  const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: opts.agentDir };
  if (opts.apiKey !== undefined) env.NANOGPT_API_KEY = opts.apiKey;

  const child = spawn(piBin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
```

with:

```ts
  const args = ["-p", "--mode", "json", "--offline", "--provider", "nanogpt", "--model", opts.candidate];
  if (opts.sessionDir !== undefined) args.push("--session-dir", opts.sessionDir);
  if (opts.continueSession) args.push("--continue");
  // The prompt goes on pi's STDIN, never argv: a review prompt can exceed Linux MAX_ARG_STRLEN
  // (128 KiB) and would E2BIG at spawn. Under --mode json (appMode !== "rpc") pi reads a piped,
  // non-TTY stdin as the prompt, so this is a transport-only swap. pi drains stdin to EOF before
  // emitting stdout, so writing while we read stdout below cannot deadlock; Node heap-buffers the
  // whole write, so >1 MiB is safe fire-and-forget.
  const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: opts.agentDir };
  if (opts.apiKey !== undefined) env.NANOGPT_API_KEY = opts.apiKey;

  const child = spawn(piBin, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  // Swallow EPIPE: a fast-failing pi (e.g. model-unavailable) may exit before draining stdin.
  child.stdin!.on("error", () => {});
  child.stdin!.write(opts.prompt);
  child.stdin!.end();
```

Note `child.stdin!` — with `stdio[0] === "pipe"` it is non-null, but TS types it `Writable | null`; the `!` keeps `npm run typecheck` clean. Attach the `error` handler **before** `write()`.

- [ ] **Step 5: Run the new and existing tests to verify they pass**

Run: `node --experimental-strip-types --test src/launch.test.ts src/bin.test.ts`
Expected: PASS. The new `echostdin`/`echolen` tests pass; the existing `launch.test.ts` suite (`good-ok`, `dumpargs`, `stall`, `hang`, `deaf`, `idlepost`) still passes (`dumpargs` asserts only `--session-dir`/`--continue`, which remain on argv); the `bin.test.ts` `nonceok` and `resume2step` end-to-end tests still pass because the fixture now reads the nonce from stdin.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/launch.ts src/test-fixtures/fake-pi.mjs src/launch.test.ts
git commit -m "$(cat <<'EOF'
feat: deliver pi prompt on stdin, not argv (Hop 2, E2BIG fix)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Read pykrete's own prompt from stdin (Hop 1)

When the positional prompt is `-`, or omitted while stdin is not a TTY, read the entire prompt from pykrete's stdin. Combined with Task 1 this gives the end-to-end contract multi-review depends on: `printf big | pykrete --config X -` works for prompts well over 128 KiB.

**Files:**
- Modify: `bin/pykrete.ts` (add a `readStream` helper; change the prompt-resolution block, currently lines ~49–53)
- Test: `src/bin.test.ts`

**Interfaces:**
- Consumes: `run(argv)` returns `{ prompt?: string, ... }` where `prompt === "-"` for a `-` positional and `undefined` when omitted (from `src/cli.ts` `parseArgv`). The `echolen` fixture scenario from Task 1.
- Produces: no new exported interface. Behaviour: a `-` or omitted-and-piped invocation reads `process.stdin`; empty/whitespace-only stdin still exits 2.

- [ ] **Step 1: Write the failing tests**

In `src/bin.test.ts`, add a stdin runner beside the existing `runBin` (after line 33). Set `maxBuffer` — spawnSync's default 1 MiB stdout cap raises `ENOBUFS`/`SIGTERM` (looks like a timeout) once a child's stdout nears 1 MiB:

```ts
function runBinStdin(config: string, input: string): SpawnSyncReturns<string> {
  return spawnSync(
    "node",
    ["--experimental-strip-types", BIN, "--config", config, "-"],
    { input, encoding: "utf-8", maxBuffer: 8 * 1024 * 1024, env: { ...process.env, PYKRETE_PI_BIN: FAKE, NANOGPT_API_KEY: "" } },
  );
}
```

Add these tests:

```ts
test("large prompt via stdin '-' reaches pi intact (no E2BIG), exit 0", () => {
  const big = "x".repeat(1_200_000); // > 1 MiB, far past MAX_ARG_STRLEN
  const r = runBinStdin(writeConfig(["echolen"]), big);
  assert.equal(r.status, 0);
  assert.match(r.stdout, new RegExp(`LEN ${big.length}\\b`));
});

test("prompt omitted while stdin is piped (non-TTY) is read from stdin", () => {
  const r = spawnSync(
    "node",
    ["--experimental-strip-types", BIN, "--config", writeConfig(["echolen"])],
    { input: "z".repeat(50_000), encoding: "utf-8", maxBuffer: 8 * 1024 * 1024, env: { ...process.env, PYKRETE_PI_BIN: FAKE, NANOGPT_API_KEY: "" } },
  );
  assert.equal(r.status, 0);
  assert.match(r.stdout, /LEN 50000\b/);
});
```

Also update the existing `"missing prompt: exit 2"` test (currently lines 53–60) to feed a closed, empty stdin explicitly so the outcome is deterministic — add `input: ""` to its options:

```ts
test("missing prompt: exit 2", () => {
  const r = spawnSync(
    "node",
    ["--experimental-strip-types", BIN, "--config", writeConfig(["good-ok"])],
    { input: "", encoding: "utf-8", env: { ...process.env, PYKRETE_PI_BIN: FAKE, NANOGPT_API_KEY: "" } },
  );
  assert.equal(r.status, 2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-strip-types --test src/bin.test.ts`
Expected: the two new tests FAIL. Without Hop 1, `--config echolen -` treats `-` as the literal prompt → pi's stdin gets `"-"` → fixture emits `LEN 1` (not `LEN 1200000`); the omitted-arg case exits 2 with empty stdout (not `LEN 50000`). The updated exit-2 test still PASSES (regression guard).

- [ ] **Step 3: Add the stdin reader and resolve the sentinel**

In `bin/pykrete.ts`, add a module-scope helper after the imports (before `main`). Read as `Buffer` and decode once — correct for multibyte content split across chunks, and for >1 MiB:

```ts
async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}
```

Replace the prompt-resolution block (currently lines 49–53):

```ts
  const prompt = resolved.prompt;
  if (prompt === undefined) {
    console.error("pykrete: no prompt provided");
    return 2;
  }
```

with (note `const` → `let`):

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --experimental-strip-types --test src/bin.test.ts`
Expected: PASS — `LEN 1200000`, `LEN 50000`, and exit 2 for empty stdin. The prompt is buffered once in `main()` and re-emitted to each pi spawn through Task 1's stdin write, so nonce/resume/failover paths are unaffected.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests pass; no type errors.

- [ ] **Step 6: Commit**

```bash
git add bin/pykrete.ts src/bin.test.ts
git commit -m "$(cat <<'EOF'
feat: read prompt from stdin on '-' / omitted-non-TTY (Hop 1)

Unblocks multi-review: pipes review prompts >128 KiB to pi without E2BIG.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Out of Scope (per the requesting project — optional, deferred)

- A structured "model actually used" line on stderr (after a downgrade).
- JSONL/event passthrough on stdout for live progress/telemetry.
- Any change to exit-code semantics in `src/failover.ts`.

## Final Verification

Beyond `npm test` + `npm run typecheck`, confirm the real end-to-end acceptance criterion against the fixture (no network):

```bash
BIG=$(node -e 'process.stdout.write("x".repeat(200000))')   # ~200 KiB, over MAX_ARG_STRLEN
# nonce_enabled=false is required: with the nonce ON (the default), pykrete appends the
# completion-sentinel suffix to the prompt, so echolen would count prompt+suffix bytes AND
# never emit the sentinel -> LEN 200213 / exit 1. Disable it for this transport check (the
# automated bin.test.ts uses the same nonce_enabled=false config).
printf '%s' "$BIG" | NANOGPT_API_KEY= PYKRETE_PI_BIN="$PWD/src/test-fixtures/fake-pi.mjs" \
  node --experimental-strip-types bin/pykrete.ts \
    --config <(printf '%s\n' 'default_family="glm"' '[families]' 'glm=["echolen"]' '[liveness]' 'nonce_enabled=false') -
# expect: the extracted assistant text "LEN 200000" on stdout (pykrete emits the text, not raw JSON), exit 0.
# The same 200 KiB passed positionally would E2BIG at the pi spawn.
```

Optionally, while a large run is live, confirm the prompt never appears in `/proc/<pid>/cmdline` for either pykrete or its `pi` child.

## Self-Review

- **Spec coverage:** Hop 1 (`-`/omitted stdin read) → Task 2. Hop 2 (no argv, no E2BIG, ≥1 MiB) → Task 1 + Task 2's `echolen` test. Exit-code contract frozen → Global Constraints + no `failover.ts` change. `--task/--family/--config` unchanged → `parseArgv` untouched (noted in File Structure).
- **Placeholder scan:** none — every code/step is concrete.
- **Type consistency:** `readStream(stream): Promise<string>`, `launchAttempt(opts).outcome.text`, fixture models `echostdin`/`echolen`, and `runBinStdin(config, input)` are used with identical names/signatures across tasks.
