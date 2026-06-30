import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createPiEventsAccumulator, type PiRunOutcome } from "./pi-events.ts";

export interface HeartbeatInfo {
  candidate: string;
  elapsedMs: number;
  events: number;
  idleMs: number;
}

export interface LaunchOptions {
  candidate: string;
  prompt: string;
  agentDir: string;
  apiKey?: string;
  startupTimeoutMs: number;
  overallTimeoutMs: number;
  piBin?: string;
  heartbeatMs?: number;
  heartbeat?: (info: HeartbeatInfo) => void;
  killGraceMs?: number;
  idleTimeoutMs?: number;
  sessionDir?: string;
  continueSession?: boolean;
}

// Grace between SIGTERM and the SIGKILL escalation, and again before force-resolving.
const DEFAULT_KILL_GRACE_MS = 5_000;

export interface AttemptOutcome {
  outcome: PiRunOutcome;
  startupTimedOut: boolean;
  overallTimedOut: boolean;
  idledOut: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

export function launchAttempt(opts: LaunchOptions): Promise<AttemptOutcome> {
  const piBin = opts.piBin ?? process.env.PYKRETE_PI_BIN ?? "pi";
  // --offline disables pi's startup network ops (the cause of the non-deterministic ~2min
  // startup stall); inference still reaches NanoGPT, and Pykrete does its own catalog fetch,
  // so pi's startup chores are pure liability here. Verified: a run with --offline returns
  // normally. The startup watchdog remains as a backstop.
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
  const acc = createPiEventsAccumulator();
  const startedAt = Date.now();
  let stderr = "";
  let startupTimedOut = false;
  let overallTimedOut = false;
  let idledOut = false;
  let firstLineSeen = false;
  let events = 0;
  let lastEventAt = startedAt;

  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  return new Promise<AttemptOutcome>((resolve) => {
    let escalateTimer: ReturnType<typeof setTimeout> | undefined;
    let forceResolveTimer: ReturnType<typeof setTimeout> | undefined;
    let rl: ReturnType<typeof createInterface> | undefined;
    let killing = false;

    // A watchdog firing only sends SIGTERM today, and the promise settles solely on the child's
    // 'close' event — so a child that traps/ignores SIGTERM, or a grandchild that inherited the
    // stdout pipe and lingers, can withhold 'close' forever and hang the whole failover loop past
    // every "hard" bound. Escalate SIGTERM -> SIGKILL after a grace, then force-resolve regardless
    // of 'close' so launchAttempt always settles. (Reliability is the prime directive.)
    const escalate = () => {
      if (killing) return;
      killing = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
      escalateTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
        forceResolveTimer = setTimeout(() => finish(null, "SIGKILL"), killGraceMs);
      }, killGraceMs);
    };

    const startupTimer = setTimeout(() => {
      startupTimedOut = true;
      escalate();
    }, opts.startupTimeoutMs);
    const overallTimer = setTimeout(() => {
      overallTimedOut = true;
      escalate();
    }, opts.overallTimeoutMs);
    // Idle watchdog: armed on the first stdout line, reset by every subsequent line. Fires when the
    // stream has been silent for longer than idleTimeoutMs. Covers the post-agent_start window the
    // startup watchdog disarms. The threshold (default 330s from config) must sit OUTSIDE pi's own
    // 300s HTTP idle window (undici body/headers timeout) so pi aborts + self-retries a silent stream
    // FIRST; the watchdog only reclaims a stream pi has genuinely abandoned. pi's agent-session retry
    // backoff (2/4/8s) emits visible stdout events that reset lastEventAt, so it is not the threat —
    // the 300s HTTP idle window is.
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const bumpIdle = () => {
      if (opts.idleTimeoutMs === undefined) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idledOut = true;
        escalate();
      }, opts.idleTimeoutMs);
    };
    // Heartbeat is best-effort and MUST NOT stop the run: a throw here (e.g. stderr EPIPE)
    // is swallowed. idleMs is observational only — the launcher never kills on idle, because
    // a stall is indistinguishable at the stdout level from pi's legitimate retry backoff;
    // the overall timer owns the hard bound.
    const heartbeatTimer =
      opts.heartbeatMs && opts.heartbeat
        ? setInterval(() => {
            const now = Date.now();
            try {
              opts.heartbeat!({ candidate: opts.candidate, elapsedMs: now - startedAt, events, idleMs: now - lastEventAt });
            } catch {
              // never let a heartbeat failure abort the run
            }
          }, opts.heartbeatMs)
        : undefined;

    let finished = false;
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(startupTimer);
      clearTimeout(overallTimer);
      if (escalateTimer) clearTimeout(escalateTimer);
      if (forceResolveTimer) clearTimeout(forceResolveTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (idleTimer) clearTimeout(idleTimer);
      // Release our read handles. On the force-resolve path the child (or a grandchild that
      // inherited the pipe) may still be alive; without this, the open stdout pipe keeps Node's
      // event loop alive and the process hangs at exit even though the promise has settled.
      rl?.close();
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      resolve({ outcome: acc.result(), startupTimedOut, overallTimedOut, idledOut, exitCode, signal, stderr });
    };

    if (child.stdout) {
      rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        if (!firstLineSeen) {
          firstLineSeen = true;
          clearTimeout(startupTimer);
        }
        events += 1;
        lastEventAt = Date.now();
        bumpIdle();
        acc.push(line);
      });
    }
    if (child.stderr) child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    child.on("close", (code, signal) => finish(code, signal));
    // Capture spawn failures (ENOENT for a missing/misconfigured pi, EPERM, ...) so the exhaustion
    // path can surface the real cause instead of a bare "unclassifiable" exit.
    child.on("error", (err: Error) => {
      if (!stderr) stderr = err.message;
      finish(null, null);
    });
  });
}
