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
type RawEvent = { type?: unknown; message?: RawMessage; toolResults?: unknown };

// pi sets a provisional stopReason ("stop") on message_start and every message_update, and only
// the terminal message_end/turn_end carries the authoritative value (e.g. "error"/"toolUse").
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
      if (obj.message && obj.message.role === "assistant") handleAssistant(obj.message, terminal);
      if (Array.isArray(obj.toolResults) && obj.toolResults.length > 0) sawAssistantOutput = true;
    },
    result(): PiRunOutcome {
      return { stopReason, errorMessage, model, text, terminalText, sawAssistantOutput };
    },
  };
}
