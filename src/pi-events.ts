export interface PiRunOutcome {
  stopReason?: string;
  errorMessage?: string;
  model?: string;
  text: string;
  terminalText: string;
  sawAssistantOutput: boolean;
}

export interface PiEventsAccumulator {
  push(line: string): void;
  result(): PiRunOutcome;
}

type RawContent = { type?: unknown; text?: unknown };
type RawMessage = { role?: unknown; stopReason?: unknown; errorMessage?: unknown; model?: unknown; content?: unknown };
type RawAssistantMessageEvent = { type?: unknown; contentIndex?: unknown; delta?: unknown; content?: unknown };
type RawEvent = {
  type?: unknown;
  message?: RawMessage;
  assistantMessageEvent?: RawAssistantMessageEvent;
  toolResults?: unknown;
};

// Older pi releases put a provisional stopReason on message_start/message_update; pi 0.84.x uses
// "pending" on message_start and omits the cumulative message from message_update. In both shapes,
// only terminal message_end/turn_end carries the authoritative value (e.g. "error"/"toolUse").
// Latching stopReason from a non-terminal envelope would make a truncated stream (pi crash /
// connection drop before any terminal event) look like a clean "stop" success — masking failure
// as exit 0 and killing the "no terminal message -> ambiguous -> failover" safety net. So only
// terminal events update stopReason/errorMessage. (Design doc: result is read from the terminal
// message_end message.)
const TERMINAL_TYPES = new Set(["message_end", "turn_end"]);

export function createPiEventsAccumulator(): PiEventsAccumulator {
  let stopReason: string | undefined;
  let errorMessage: string | undefined;
  let model: string | undefined;
  let text = "";
  let terminalText = "";
  let sawAssistantOutput = false;
  const streamedTextBlocks = new Map<number, string[]>();
  let streamedTextDirty = false;

  function materializeStreamedText(): void {
    if (!streamedTextDirty) return;
    streamedTextDirty = false;
    const streamedText = [...streamedTextBlocks.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, chunks]) => chunks.join(""))
      .join("");
    if (streamedText.length > 0) {
      sawAssistantOutput = true;
      text = streamedText;
    }
  }

  function handleAssistantMessageEvent(event: RawAssistantMessageEvent): void {
    if (!Number.isInteger(event.contentIndex) || (event.contentIndex as number) < 0) return;
    const contentIndex = event.contentIndex as number;
    if (event.type === "text_start") {
      streamedTextBlocks.set(contentIndex, []);
    } else if (event.type === "text_delta" && typeof event.delta === "string") {
      const chunks = streamedTextBlocks.get(contentIndex) ?? [];
      chunks.push(event.delta);
      streamedTextBlocks.set(contentIndex, chunks);
      if (event.delta.length > 0) sawAssistantOutput = true;
    } else if (event.type === "text_end" && typeof event.content === "string") {
      streamedTextBlocks.set(contentIndex, [event.content]);
      if (event.content.length > 0) sawAssistantOutput = true;
    } else {
      return;
    }
    streamedTextDirty = true;
  }

  function handleAssistant(msg: RawMessage, terminal: boolean): void {
    if (terminal && typeof msg.stopReason === "string") stopReason = msg.stopReason;
    if (terminal && typeof msg.errorMessage === "string") errorMessage = msg.errorMessage;
    if (typeof msg.model === "string") model = msg.model;
    const content = Array.isArray(msg.content) ? (msg.content as RawContent[]) : [];
    let turnText = "";
    for (const c of content) {
      if (c && c.type === "text" && typeof c.text === "string") turnText += c.text;
    }
    if (turnText.length > 0) {
      sawAssistantOutput = true;
      text = turnText;
      // A cumulative message carries authoritative full text, which must take precedence over
      // older streamed deltas when result() materializes the stream later.
      streamedTextDirty = false;
    }
    // The nonce liveness gate must read the genuinely-final block. Capture the terminal message's
    // text separately; only overwrite on a NON-EMPTY terminal turn so a trailing empty turn_end after
    // a text-bearing message_end does not erase it.
    if (terminal && turnText.length > 0) terminalText = turnText;
  }

  return {
    push(line: string): void {
      let obj: RawEvent;
      try {
        obj = JSON.parse(line) as RawEvent;
      } catch {
        return;
      }
      if (!obj || typeof obj !== "object") return;
      const terminal = typeof obj.type === "string" && TERMINAL_TYPES.has(obj.type);
      if (obj.message && obj.message.role === "assistant") {
        // pi 0.84.x's message_start can already contain the first streamed chunk, which is then
        // repeated by text_delta. Keep cumulative-message handling for older pi releases, but build
        // the new delta stream independently so that first chunk is not duplicated.
        if (obj.type === "message_start") {
          streamedTextBlocks.clear();
          streamedTextDirty = false;
        }
        handleAssistant(obj.message, terminal);
      }
      if (obj.type === "message_update" && obj.assistantMessageEvent) {
        handleAssistantMessageEvent(obj.assistantMessageEvent);
      }
      if (Array.isArray(obj.toolResults) && obj.toolResults.length > 0) sawAssistantOutput = true;
    },
    result(): PiRunOutcome {
      materializeStreamedText();
      return { stopReason, errorMessage, model, text, terminalText, sawAssistantOutput };
    },
  };
}
