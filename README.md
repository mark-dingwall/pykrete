# Pykrete

A headless launcher that wires the [`pi`](https://github.com/earendil-works/pi) coding agent to
NanoGPT as its sole inference provider, reliably enough that NanoGPT is safe to use for real work.

Pykrete is a drop-in sibling of `claude -p` / `codex -p` / `opencode`: you hand it a prompt, it
picks a model, runs the agent, and gets out of the way. The caller never sees transport mechanics —
no model ids, no failover, no retries, no session plumbing. The call either works or fails with a
meaningful exit code.

## Why it exists

NanoGPT is cheap and has a broad catalog, but individual models are unreliable in ways that are
invisible from the outside: a model 404s after a rename, another stalls mid-inference, another
returns a truncated stream that looks like a clean stop. Pykrete's job is to absorb all of that.

Two design decisions follow from that job and are worth not re-litigating:

**pi is a subprocess, not a library.** Pykrete spawns the binary and parses `--mode json`. It
imports nothing from pi's SDK. pi moves fast and reshuffles its SDK surface between minor versions
(0.80.8 replaced `modelRegistry`/`authStorage` with `modelRuntime`); none of that reaches Pykrete.
What Pykrete depends on instead is four narrow contracts — the `models.json` provider schema, the
`settings.json` retry schema, the `--mode json` envelope, and extension loading — all of which have
only ever changed additively. The cost is that `pi` is an undeclared runtime dependency resolved off
`PATH`; see the backlog.

**NanoGPT is the only provider.** Every candidate is a model entry under one `nanogpt` provider with
one `baseUrl`, so every request goes to the same edge. That uniformity is load-bearing: it is what
makes "this error was caused by the request, not the model" a sound inference, and therefore what
lets Pykrete decide when failing over to another candidate is pointless.

## Scope

Pykrete owns **transport reliability only** — picking a model, failing over, and detecting that a
run died. It deliberately does not judge whether the work was any *good*: no test-passing gate, no
spec-compliance check, no over-claim detection, no task decomposition. Those belong to an
orchestration layer above it. The intended shape is plan-then-execute: planning stays with frontier
models, and NanoGPT models are strictly executors of mechanical, spec-driven work.

The one apparent exception is the sentinel nonce, which looks semantic but isn't — a missing nonce
means *the transport died*, not *the answer was wrong*.

## Installation

Requires Node ≥ 22.18 (native TypeScript via `--experimental-strip-types`).

```bash
git clone https://github.com/mark-dingwall/pykrete.git
cd pykrete
npm i
npm link       # puts `pykrete` on PATH
```

Or, without installing: `npx github:mark-dingwall/pykrete "<prompt>"` — re-fetches on every run unless
pinned to a tag, and still needs a `pykrete.toml` and a key in the directory you run it from (see
Quickstart below); npx does not put `pykrete.example.toml` or `.env.example` in your cwd, so fetch
those from the repo yourself first.

## Quickstart

```bash
npm i -g @earendil-works/pi-coding-agent@0.80.10   # pi must be on PATH
cp pykrete.example.toml pykrete.toml               # config is required
cp .env.example .env                               # fill in NANOGPT_API_KEY, or export it directly
pykrete "Write hello.txt containing PONG."
```

A non-empty shell env still takes precedence over `.env` if both are set; an empty shell export is
treated as absent, so it won't silently shadow a valid `.env` value.

The prompt may be a positional argument, `-` to read stdin, or piped stdin. It always reaches pi via
stdin, never argv — a large prompt on argv would exceed `MAX_ARG_STRLEN` and `E2BIG` at spawn.

```
pykrete [--task <task>] [--family <family>] [--config <path>] "<prompt>"
```

`--family` selects a candidate chain from `[families]`; `--task` selects that family's lead model
from `[defaults.<task>]`. Everything is documented inline in `pykrete.example.toml`.

## Exit codes

The contract is frozen. `{0, 3}` are success, `{1, 2, 4}` are failure — a caller that only needs
"did it work" can test for the first set and ignore the rest.

| Code | Meaning |
|------|---------|
| 0 | Success on the intended lead model |
| 3 | Success, but on a substituted model after failover (a warning goes to stderr) |
| 1 | Run error — fatal, transient, or died after producing output |
| 2 | Usage error — bad config, unknown family, missing prompt, unloadable `.env`, or missing API key |
| 4 | Every candidate was unavailable |

Note that `pi --mode json` exits 0 even on a failed run, so Pykrete classifies on the terminal
message's `stopReason`, never on pi's exit code.

## Environment

| Variable | Purpose |
|----------|---------|
| `NANOGPT_API_KEY` | Required. From the shell environment or a `.env` file in the working directory (a non-empty shell value wins if both are set). |
| `PYKRETE_PI_BIN` | Override the `pi` binary (default: `pi` on `PATH`). |
| `PYKRETE_HEARTBEAT_SECONDS` | Emit a periodic JSON progress line to stderr (`{"pykrete":"heartbeat",...}`). |
| `PYKRETE_MODELS_URL` | Test seam for the catalog endpoint. Unset = production. |
| `PYKRETE_SKIP_KEY_PREFLIGHT` | Test seam to bypass the `NANOGPT_API_KEY` preflight. Unset = production. |

A missing API key now fails cleanly: Pykrete checks for it (after attempting to load `.env`) before
doing anything else, and exits 2 with a clear message if it's absent.

## Tests

```bash
npm test          # unit suite, no network, no pi binary needed
npm run typecheck
npm run test:e2e  # real pi + real NanoGPT; hard-fails if PYKRETE_NEW_PI_BIN is unset
```

The e2e suite is gated on `PYKRETE_NEW_PI_BIN` pointing at a real pi binary, and `npm run test:e2e`
refuses to run without it. That refusal is deliberate: the suite used to skip silently, which meant
it could report "all pass" while executing nothing at all. One further case is gated behind
`PYKRETE_DS4_MODEL` because it deliberately spends ~500k tokens.

## Layout

```
bin/pykrete.ts     CLI entry — argv, stdin, exit codes
src/config.ts      pykrete.toml parsing         src/resolve.ts     family → candidate chain
src/catalog.ts     NanoGPT model catalog        src/agentdir.ts    temp PI_CODING_AGENT_DIR
src/launch.ts      spawn pi, watchdogs          src/pi-events.ts   --mode json stream accumulator
src/classify.ts    outcome → verdict            src/failover.ts    candidate loop → exit code
src/runCandidate.ts  one candidate, incl. nonce-resume
docs/BACKLOG.md    known gaps        docs/superpowers/  specs and plans
extensions/        pi extensions (flat-edit — NOT currently wired in; see backlog)
```

Only `smol-toml` is a runtime dependency.

## License

MIT — see [LICENSE](LICENSE).
