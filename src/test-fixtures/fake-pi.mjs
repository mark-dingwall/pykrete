#!/usr/bin/env node
// Minimal pi stand-in. Chooses a scenario from the --model value and emits
// pi-style JSON lines on stdout. Used only by launch.test.ts / bin.test.ts.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
let model = "";
for (let i = 0; i < argv.length; i++) if (argv[i] === "--model") model = argv[i + 1] ?? "";

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const assistant = (fields) => emit({ type: "message_end", message: { role: "assistant", model, ...fields } });

async function readStdin() {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const c of process.stdin) data += c;
  return data;
}

if (model.includes("stall")) {
  // never emit anything -> triggers startup timeout
  setTimeout(() => {}, 10_000);
} else if (model.includes("hang")) {
  emit({ type: "agent_start" }); // disarms startup timer, then hangs -> overall timeout
  setTimeout(() => {}, 10_000);
} else if (model.includes("deaf")) {
  // Trap SIGTERM and keep running -> the watchdog must escalate to SIGKILL to reclaim us.
  process.on("SIGTERM", () => {});
  emit({ type: "agent_start" });
  setTimeout(() => {}, 10_000);
} else if (model.includes("bad400")) {
  assistant({ content: [], stopReason: "error", errorMessage: `400 Model ${model} is not supported on /v1/chat/completions.` });
} else if (model.includes("auth401")) {
  assistant({ content: [], stopReason: "error", errorMessage: "401 Invalid session" });
} else if (model.includes("rate429")) {
  assistant({ content: [], stopReason: "error", errorMessage: "429 rate_limit_error" });
} else if (model.includes("midrun")) {
  assistant({ content: [{ type: "text", text: "PARTIAL" }], stopReason: "stop" });
  assistant({ content: [], stopReason: "error", errorMessage: `400 Model ${model} is not supported` });
} else if (model.includes("idlepost")) {
  // Emit output then hang -> post-output idle stall (sawAssistantOutput true, no terminal event).
  emit({ type: "agent_start" });
  emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "THINKING" }] } });
  setTimeout(() => {}, 10_000);
} else if (model.includes("dumpargs")) {
  emit({ type: "agent_start" });
  assistant({ content: [{ type: "text", text: argv.join(" ") }], stopReason: "stop" });
} else if (model.includes("nonceok")) {
  const prompt = await readStdin();
  const nonce = (/WORK COMPLETE ([0-9a-f]{16})/.exec(prompt) ?? [])[1] ?? "";
  emit({ type: "agent_start" });
  assistant({ content: [{ type: "text", text: `RESULT-OK\nWORK COMPLETE ${nonce}` }], stopReason: "stop" });
  emit({ type: "agent_end" });
} else if (model.includes("resume2step")) {
  const continuing = argv.includes("--continue");
  const sdIdx = argv.indexOf("--session-dir");
  const sessionDir = sdIdx >= 0 ? argv[sdIdx + 1] : undefined;
  if (!continuing) {
    // Attempt 1: produce output WITHOUT the nonce, and write a resumable .jsonl (as real pi does).
    if (sessionDir) writeFileSync(join(sessionDir, "session.jsonl"), '{"type":"message"}\n');
    emit({ type: "agent_start" });
    assistant({ content: [{ type: "text", text: "PARTIAL-WORK" }], stopReason: "stop" });
    emit({ type: "agent_end" });
  } else {
    // Resume: now emit the nonce carried in the resume prompt and complete.
    const prompt = await readStdin();
    const nonce = (/WORK COMPLETE ([0-9a-f]{16})/.exec(prompt) ?? [])[1] ?? "";
    emit({ type: "agent_start" });
    assistant({ content: [{ type: "text", text: `RESULT-OK\nWORK COMPLETE ${nonce}` }], stopReason: "stop" });
    emit({ type: "agent_end" });
  }
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
} else {
  emit({ type: "agent_start" });
  assistant({ content: [{ type: "text", text: "RESULT-OK" }], stopReason: "stop" });
  emit({ type: "agent_end" });
}
