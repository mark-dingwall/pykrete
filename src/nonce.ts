import { randomBytes } from "node:crypto";

// 8 bytes -> 16 hex chars, matching the ancestor bench's secrets.token_hex(8).
export function mintNonce(): string {
  return randomBytes(8).toString("hex");
}

// Appended to the caller's prompt on the FIRST attempt only. Instructs the model to end its final
// message with the exact marker, and fences it as a liveness-only token that must never be written
// to a file (guards the bench's H2 chain where models echoed injected text into deliverables).
export function buildSuffix(nonce: string): string {
  return [
    "",
    "---",
    "When the task is genuinely complete, end your final message with exactly this line:",
    `WORK COMPLETE ${nonce}`,
    "This line is a liveness marker only. Do NOT write it to any file or include it in any output.",
  ].join("\n");
}

// Sent on a --continue resume. Status-only: carries NO worktree state (Contract 06-05). The nonce is
// reused (it already lives in session history from the first attempt), not regenerated.
export function buildResumePrompt(nonce: string): string {
  return [
    "Your previous session stopped, but the task may not be complete. This block is",
    "status only — do NOT write it to any file. If the task is incomplete, continue.",
    "If it is genuinely complete, end your final message with exactly:",
    `WORK COMPLETE ${nonce}`,
    "and then stop.",
  ].join("\n");
}

// Presence = the FINAL assistant text block contains the exact marker. Substring + trim, so pi's
// configurable --mode json output padding (commit 6564d947) cannot break an exact-equals check.
export function noncePresent(finalText: string, nonce: string): boolean {
  return finalText.trim().includes(`WORK COMPLETE ${nonce}`);
}

// Remove the marker line(s) so stdout never leaks the liveness token to the caller.
export function stripSentinel(text: string, nonce: string): string {
  const marker = `WORK COMPLETE ${nonce}`;
  return text
    .split("\n")
    .filter((line) => !line.includes(marker))
    .join("\n")
    .trimEnd();
}
