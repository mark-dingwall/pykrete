// src/pi-events.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPiEventsAccumulator } from "./pi-events.ts";

function feed(lines: string[]) {
  const acc = createPiEventsAccumulator();
  for (const l of lines) acc.push(l);
  return acc.result();
}

test("success run: captures stop reason, model, and reconstructed text", () => {
  const r = feed([
    `{"type":"session","id":"x"}`,
    `{"type":"agent_start"}`,
    `{"type":"message_end","message":{"role":"assistant","model":"openai/gpt-5-nano","content":[{"type":"text","text":"PONG"}],"stopReason":"stop"}}`,
  ]);
  assert.equal(r.stopReason, "stop");
  assert.equal(r.model, "openai/gpt-5-nano");
  assert.equal(r.text, "PONG");
  assert.equal(r.sawAssistantOutput, true);
});

test("model-unavailable error: empty content, error stop reason, no output seen", () => {
  const r = feed([
    `{"type":"message_end","message":{"role":"assistant","model":"bad/id","content":[],"stopReason":"error","errorMessage":"400 Model bad/id is not supported on /v1/chat/completions."}}`,
  ]);
  assert.equal(r.stopReason, "error");
  assert.equal(r.errorMessage, "400 Model bad/id is not supported on /v1/chat/completions.");
  assert.equal(r.text, "");
  assert.equal(r.sawAssistantOutput, false);
});

test("output-then-error: sawAssistantOutput stays true across turns", () => {
  const r = feed([
    `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"working..."}],"stopReason":"stop"}}`,
    `{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"400 Model x not supported"}}`,
  ]);
  assert.equal(r.sawAssistantOutput, true);
  assert.equal(r.stopReason, "error");
});

test("real pi envelope sequence: provisional stops ignored, terminal latched, agent_end inert", () => {
  // Mirrors the real .research/_live/ping.jsonl shape: message_start + message_update carry a
  // provisional stopReason:"stop"; the authoritative value lives on message_end/turn_end; a
  // trailing agent_end carries no stopReason and must not disturb the latched result. Guards the
  // TERMINAL_TYPES set against a regression where a non-terminal type starts (or stops) latching.
  const r = feed([
    `{"type":"message_start","message":{"role":"assistant","content":[],"stopReason":"stop"}}`,
    `{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"PO"}],"stopReason":"stop"}}`,
    `{"type":"message_end","message":{"role":"assistant","model":"glm/x","content":[{"type":"text","text":"PONG"}],"stopReason":"stop"}}`,
    `{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"PONG"}],"stopReason":"stop"}}`,
    `{"type":"agent_end"}`,
  ]);
  assert.equal(r.stopReason, "stop");
  assert.equal(r.model, "glm/x");
  assert.equal(r.text, "PONG");
  assert.equal(r.sawAssistantOutput, true);
});

test("a stream truncated before any terminal event is not a false 'stop' success", () => {
  // pi stamps a provisional stopReason:"stop" on message_start / message_update; if the run dies
  // (crash, connection drop) before a terminal message_end/turn_end, that provisional value must
  // NOT be latched — otherwise classify would report a clean success on an empty/partial run.
  const r = feed([
    `{"type":"message_start","message":{"role":"assistant","content":[],"stopReason":"stop"}}`,
    `{"type":"message_update","message":{"role":"assistant","content":[],"stopReason":"stop"}}`,
  ]);
  assert.equal(r.stopReason, undefined);
  assert.equal(r.sawAssistantOutput, false);
});

test("tolerates non-JSON and message-less lines", () => {
  const r = feed([`not json`, `{"type":"heartbeat"}`, `{"message":{"role":"user","content":[]}}`]);
  assert.equal(r.stopReason, undefined);
  assert.equal(r.sawAssistantOutput, false);
  assert.equal(r.text, "");
});

test("tool activity counts as output even without assistant text", () => {
  const r = feed([`{"type":"turn_end","toolResults":[{"ok":true}]}`]);
  assert.equal(r.sawAssistantOutput, true);
});

test("terminalText captures the terminal block's text, not a non-terminal update", () => {
  const r = feed([
    `{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"WORK COMPLETE abc"}]}}`,
    `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"final answer"}],"stopReason":"stop"}}`,
  ]);
  assert.equal(r.terminalText, "final answer");
  assert.equal(r.text, "final answer"); // last non-empty turn also happens to be terminal here
});

test("a nonce in a non-terminal block with an EMPTY terminal turn does NOT survive in terminalText", () => {
  const r = feed([
    `{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"WORK COMPLETE abc"}]}}`,
    `{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"stop"}}`,
  ]);
  assert.equal(r.text, "WORK COMPLETE abc"); // preserved for emission (last non-empty turn)
  assert.equal(r.terminalText, "");          // but the TERMINAL block was empty -> nonce cannot count
});

test("terminalText defaults to empty when no terminal event arrives", () => {
  const r = feed([`{"type":"message_start","message":{"role":"assistant","content":[{"type":"text","text":"x"}]}}`]);
  assert.equal(r.terminalText, "");
});

// pi 0.84.x removed cumulative `message` snapshots from JSON-mode message_update events.
// Streaming text now arrives only through assistantMessageEvent deltas. These guards exercise
// Pykrete's boundary contract using the exact serialized field names from pi's JsonAgentSessionEvent.

test("pi 0.84.x delta-only updates reconstruct partial text without duplicating message_start", () => {
  const r = feed([
    `{"type":"message_start","message":{"role":"assistant","content":[{"type":"text","text":"one"}],"stopReason":"pending"}}`,
    `{"type":"message_update","assistantMessageEvent":{"type":"text_start","contentIndex":0}}`,
    `{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"one"}}`,
    `{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":" two"}}`,
  ]);
  assert.equal(r.text, "one two");
  assert.equal(r.sawAssistantOutput, true);
  assert.equal(r.stopReason, undefined);
  assert.equal(r.terminalText, "");
});

test("pi 0.84.x delta text blocks are reconstructed in content-index order", () => {
  const r = feed([
    `{"type":"message_start","message":{"role":"assistant","content":[],"stopReason":"pending"}}`,
    `{"type":"message_update","assistantMessageEvent":{"type":"text_start","contentIndex":2}}`,
    `{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":2,"delta":"second"}}`,
    `{"type":"message_update","assistantMessageEvent":{"type":"text_start","contentIndex":0}}`,
    `{"type":"message_update","assistantMessageEvent":{"type":"text_end","contentIndex":0,"content":"first "}}`,
  ]);
  assert.equal(r.text, "first second");
  assert.equal(r.sawAssistantOutput, true);
});

test("pi 0.84.x delta text is materialized only when result is requested", () => {
  // This fails if push() returns to rebuilding all blocks for every delta, which makes a long
  // response quadratic in copied characters. The accumulator remains real; Array#join is only
  // observed to distinguish streaming accumulation from materialization at its public boundary.
  const acc = createPiEventsAccumulator();
  const arrayPrototype = Array.prototype as unknown as { join: (...args: unknown[]) => string };
  const originalJoin = arrayPrototype.join;
  let joins = 0;
  let joinsDuringStreaming: number;
  arrayPrototype.join = function (this: unknown[], ...args: unknown[]): string {
    joins += 1;
    return originalJoin.apply(this, args);
  };

  try {
    acc.push(`{"type":"message_update","assistantMessageEvent":{"type":"text_start","contentIndex":0}}`);
    acc.push(`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"first"}}`);
    acc.push(`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":" second"}}`);
    joinsDuringStreaming = joins;
  } finally {
    arrayPrototype.join = originalJoin;
  }

  assert.equal(joinsDuringStreaming, 0);
  assert.equal(acc.result().text, "first second");
});

test("terminal message text overrides pi 0.84.x delta reconstruction", () => {
  const r = feed([
    `{"type":"message_start","message":{"role":"assistant","content":[],"stopReason":"pending"}}`,
    `{"type":"message_update","assistantMessageEvent":{"type":"text_start","contentIndex":0}}`,
    `{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"partial WORK COMPLETE stale"}}`,
    `{"type":"message_end","message":{"role":"assistant","model":"glm/x","content":[{"type":"text","text":"final answer"}],"stopReason":"stop"}}`,
  ]);
  assert.equal(r.text, "final answer");
  assert.equal(r.terminalText, "final answer");
  assert.equal(r.stopReason, "stop");
  assert.equal(r.model, "glm/x");
});

test("pi 0.84.x delta text never becomes terminalText before a terminal event", () => {
  const r = feed([
    `{"type":"message_start","message":{"role":"assistant","content":[],"stopReason":"pending"}}`,
    `{"type":"message_update","assistantMessageEvent":{"type":"text_start","contentIndex":0}}`,
    `{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"WORK COMPLETE stale"}}`,
  ]);
  assert.equal(r.text, "WORK COMPLETE stale");
  assert.equal(r.terminalText, "");
  assert.equal(r.stopReason, undefined);
});

// --- pi 0.80.10 upgrade regression guards (pi commit e9fa5a68 / 351efc82) ---
//
// New pi emits a trailing lifecycle event AFTER the terminal assistant message. Its EXACT shape,
// from pi packages/coding-agent/src/core/agent-session.ts:
//   AgentSessionEvent union member:   | { type: "agent_settled" }
//   emitted in _emitAgentSettled():   this._emit({ type: "agent_settled" });
// print-mode.ts serializes every subscribed event verbatim as `${JSON.stringify(event)}\n`, so the
// raw JSONL line is literally {"type":"agent_settled"} — no `message`, no role, no stopReason, no
// content, no nonce. A consumer that latched the LAST JSON line as terminal would now land on this
// contentless event; Pykrete instead latches only message_end/turn_end assistant events, so it must
// stay inert. These tests feed streams faithful to the new pi shape and assert accumulator OUTPUT.

test("trailing agent_settled after a text-bearing message_end does NOT clobber terminal result", () => {
  // CRITICAL guard. Real new-pi terminal sequence: authoritative message_end (stopReason + model +
  // nonce text), then the lifecycle event {"type":"agent_settled"} as the final line. If the
  // accumulator ever took the last line as terminal, stopReason/model/terminalText would all reset.
  const r = feed([
    `{"type":"message_start","message":{"role":"assistant","content":[],"stopReason":"stop"}}`,
    `{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"PO"}],"stopReason":"stop"}}`,
    `{"type":"message_end","message":{"role":"assistant","model":"openai/gpt-5-nano","content":[{"type":"text","text":"PONG WORK-COMPLETE-n0nce7"}],"stopReason":"stop"}}`,
    `{"type":"agent_settled"}`,
  ]);
  assert.equal(r.stopReason, "stop");
  assert.equal(r.model, "openai/gpt-5-nano");
  assert.equal(r.terminalText, "PONG WORK-COMPLETE-n0nce7"); // nonce liveness reads this
  assert.equal(r.text, "PONG WORK-COMPLETE-n0nce7");
  assert.equal(r.sawAssistantOutput, true);
});

test("agent_settled as ABSOLUTE last line, after a trailing empty turn_end, still preserves the nonce", () => {
  // Combines both guards: the terminal-block-empty guard (a later EMPTY terminal turn_end must not
  // erase terminalText) AND agent_settled inertness. SYNTHETIC, defensive — pi 0.80.10 re-emits the
  // same message object in turn_end that it sent in message_end (agent-loop.ts:193,224), so it does
  // not empty the content; only the trailing {"type":"agent_settled"} is a captured pi shape.
  // If either guard regressed, terminalText would be "" and the nonce liveness gate would false-fail.
  const r = feed([
    `{"type":"message_end","message":{"role":"assistant","model":"moonshotai/kimi-k2","content":[{"type":"text","text":"answer DONE-nonce42"}],"stopReason":"stop"}}`,
    `{"type":"turn_end","message":{"role":"assistant","content":[],"stopReason":"stop"}}`,
    `{"type":"agent_settled"}`,
  ]);
  assert.equal(r.stopReason, "stop");
  assert.equal(r.model, "moonshotai/kimi-k2");
  assert.equal(r.terminalText, "answer DONE-nonce42");
  assert.equal(r.sawAssistantOutput, true);
});

test("terminal message_end with stopReason 'length' is latched and its text captured", () => {
  // pi commit 351efc82 only changes INTERNAL loop behaviour: a "length" stop WITH tool calls routes
  // to failToolCallsFromTruncatedMessage() and continues (terminate:false). A terminal "length" with
  // no further tools still surfaces as a normal message_end — vocabulary unchanged
  // (packages/ai/src/types.ts StopReason = "stop"|"length"|"toolUse"|"error"|"aborted"). The
  // accumulator must latch it verbatim; downstream classify decides success-if-nonce / incomplete.
  const r = feed([
    `{"type":"message_end","message":{"role":"assistant","model":"openai/gpt-5-nano","content":[{"type":"text","text":"partial output ends abru"}],"stopReason":"length"}}`,
    `{"type":"agent_settled"}`,
  ]);
  assert.equal(r.stopReason, "length");
  assert.equal(r.terminalText, "partial output ends abru");
  assert.equal(r.sawAssistantOutput, true);
});

test("stream of only non-terminal events + trailing agent_settled yields stopReason undefined (pi crashed pre-terminal)", () => {
  // If pi dies after streaming partial output but before any message_end/turn_end, the ONLY trailing
  // event may be {"type":"agent_settled"} (emitted in the finally of _runAgentPrompt). agent_settled
  // must NOT be mistaken for a terminal event: no stopReason latches -> classify sees ambiguous ->
  // failover fires. Regression here (treating agent_settled as terminal) would mask a crash as clean.
  const r = feed([
    `{"type":"message_start","message":{"role":"assistant","content":[],"stopReason":"stop"}}`,
    `{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"thinking"}],"stopReason":"stop"}}`,
    `{"type":"agent_settled"}`,
  ]);
  assert.equal(r.stopReason, undefined);
  assert.equal(r.terminalText, "");
});
