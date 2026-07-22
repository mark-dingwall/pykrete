# Working on Pykrete

Read `README.md` first for what this is and why. This file is the set of things that will bite you,
each of which cost real debugging time to learn.

## Invariants — do not change without reading the reasoning

**The exit-code contract is frozen.** `{0, 3}` success, `{1, 2, 4}` failure. Callers depend on it.
Renumbering is a breaking change to every consumer, and 3 vs 0 (substituted model vs intended lead)
is a distinction callers actually use.

**Classify on `stopReason`, never on pi's exit code.** `pi --mode json` exits 0 even when the run
failed. The exit code carries no information; `AttemptOutcome.exitCode` exists but is deliberately
unused.

**The request-uniformity invariant.** Failover replays the *identical* request against another
candidate under the same provider and `baseUrl`. So any error caused by the request itself cannot be
fixed by failing over, and must classify as `fatal` — otherwise Pykrete burns every candidate
re-sending a request that cannot succeed. This is why `400 model field is required` and `413 Request
Entity Too Large` are both `fatal` rather than `transient`. The 413 case was re-argued and settled in
review on 2026-07-20; don't reopen it without new evidence about per-model body limits.

**The prompt goes on stdin, never argv.** A large prompt on argv exceeds `MAX_ARG_STRLEN` (128 KiB)
and `E2BIG`s at spawn. `launch.ts` writes it to pi's stdin; keep it that way.

**`idle_timeout_seconds` must stay above 300.** pi's own undici HTTP idle window is 300s. Pykrete's
watchdog sits deliberately outside it (default 330) so pi aborts and self-retries first. A lower
value kills a healthy pi mid-request — the exact failure the watchdog exists to prevent. The config
parser does *not* enforce this floor yet (backlogged).

**The nonce must be read from `terminalText`.** Not from the last non-empty turn. pi re-emits the
same message object in `turn_end` that it sent in `message_end`, so only the terminal block is
authoritative.

## Tripwires

**Custom tool overrides are silently inactive unless the tool stays in the `--tools` allowlist.**
pi gates custom tools through `isAllowedTool` (sdk.ts:249). Drop `edit` from the allowlist while
overriding `edit` and you get no error — just the built-in behaviour back, quietly.

**`extensions/flat-edit.ts` is not wired in.** It exists, it was validated, and nothing loads it.
That means R3 is live: DeepSeek-via-NanoGPT deterministically fails on pi's nested `edits[].oldText`
schema. Creating files works (that's `write`); *editing* an existing file with `--family deepseek`
fails with "Upstream emitted malformed tool call data that could not be repaired". Don't assume the
extension is active because it's in the tree.

**Nothing loads `.env`.** `NANOGPT_API_KEY` must already be exported, for both the CLI and the e2e
suite. A missing key does not fail cleanly — pi dies in its auth preflight and emits no terminal JSON
event at all, so the run surfaces as an opaque failure rather than "no API key".

**A network outage has no HTTP status.** It arrives as `errorMessage: "Connection error."` and
classifies as `ambiguous`. `runCandidate` probes reachability before failing over on `ambiguous`,
otherwise a single outage cascades through and burns every candidate.

**Never import from pi's SDK.** Pykrete is a CLI consumer: spawn the binary, parse `--mode json`.
This is what makes pi's frequent SDK reshuffles a non-event. The four contracts Pykrete does rely on
are listed in the README.

**Model ids move fast.** Treat families as families, not pinned versions, and check ids against
`https://nano-gpt.com/api/v1/models` before trusting them. Note that endpoint is *public* — it
returns 200 for a bogus key, so it can never validate credentials.

## Conventions

Node ≥ 22.18 native TypeScript (`--experimental-strip-types`), ESM, `node:test` +
`node:assert/strict`. `smol-toml` is the only runtime dependency — keep it that way.

Tests assert observable behaviour at the boundary. Derive them from intended behaviour, not from the
implementation; a test that cannot fail is worse than no test. The e2e suite is the standing example
of why: it silently skipped when `PYKRETE_NEW_PI_BIN` was unset, so it reported "2 pass" while
executing nothing, and its shadow-detection patterns missed the exact upstream error string they
existed to catch. `npm run test:e2e` now hard-fails on an unset binary. Don't reintroduce a
skip-by-default path.

## Verifying a change

```bash
npm test && npm run typecheck
PYKRETE_NEW_PI_BIN=$(readlink -f "$(which pi)") npm run test:e2e   # needs NANOGPT_API_KEY exported
```

`npm test` needs no network and no pi binary. Anything touching classify, launch, agentdir, or the
event accumulator should also get the e2e run — those are precisely the areas where unit tests
encode assumptions about pi rather than facts about it.
