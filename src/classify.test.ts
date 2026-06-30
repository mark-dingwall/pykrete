import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, parseStatus } from "./classify.ts";
import type { PiRunOutcome } from "./pi-events.ts";

const ok = { startupTimedOut: false, overallTimedOut: false };
function out(o: Partial<PiRunOutcome>): PiRunOutcome {
  return { text: "", terminalText: "", sawAssistantOutput: false, ...o };
}

test("parseStatus reads a leading 3-digit status", () => {
  assert.equal(parseStatus("400 Model x not supported"), 400);
  assert.equal(parseStatus("401 Invalid session"), 401);
  assert.equal(parseStatus("no status here"), undefined);
});

test("stop and length are success", () => {
  assert.equal(classify(out({ stopReason: "stop" }), ok).kind, "success");
  assert.equal(classify(out({ stopReason: "length" }), ok).kind, "success");
});

test("400 referencing the model is model-unavailable", () => {
  const v = classify(out({ stopReason: "error", model: "bad/id", errorMessage: "400 Model bad/id is not supported on /v1/chat/completions." }), ok);
  assert.equal(v.kind, "model-unavailable");
});

test("400 without a model reference is fatal", () => {
  const v = classify(out({ stopReason: "error", errorMessage: "400 messages: field required" }), ok);
  assert.equal(v.kind, "fatal");
});

test("400 mentioning 'model' without an unavailability phrase is fatal (not failover)", () => {
  // A request-shaped 400 that happens to contain the word "model" must not route to failover/exit 4.
  assert.equal(classify(out({ stopReason: "error", errorMessage: "400 model field is required" }), ok).kind, "fatal");
});

test("400 'not supported' without a model reference is fatal (endpoint/tier, not the model)", () => {
  assert.equal(classify(out({ stopReason: "error", errorMessage: "400 streaming not supported for this account tier" }), ok).kind, "fatal");
});

test("model-unavailable via the phrase fallback when the id is not echoed (model undefined)", () => {
  // Exercises the `\bmodel\b` + unavailability-phrase path, not the launched-id echo branch.
  assert.equal(classify(out({ stopReason: "error", errorMessage: "400 model is not supported" }), ok).kind, "model-unavailable");
  assert.equal(classify(out({ stopReason: "error", errorMessage: "403 model is not available on your plan" }), ok).kind, "model-unavailable");
});

test("401/402 fatal; key-level 403 fatal; model-referenced 403 and 404 model-unavailable", () => {
  assert.equal(classify(out({ stopReason: "error", errorMessage: "401 Invalid session" }), ok).kind, "fatal");
  assert.equal(classify(out({ stopReason: "error", errorMessage: "402 Insufficient balance" }), ok).kind, "fatal");
  assert.equal(classify(out({ stopReason: "error", errorMessage: "403 permission_denied_error" }), ok).kind, "fatal");
  assert.equal(classify(out({ stopReason: "error", model: "x/y", errorMessage: "403 Model x/y is not available on your plan" }), ok).kind, "model-unavailable");
  assert.equal(classify(out({ stopReason: "error", errorMessage: "404 not_found_error" }), ok).kind, "model-unavailable");
});

test("429 and 5xx are transient", () => {
  assert.equal(classify(out({ stopReason: "error", errorMessage: "429 rate_limit_error" }), ok).kind, "transient");
  assert.equal(classify(out({ stopReason: "error", errorMessage: "503 service_unavailable" }), ok).kind, "transient");
});

test("error with unparseable status is ambiguous", () => {
  assert.equal(classify(out({ stopReason: "error", errorMessage: "connection reset" }), ok).kind, "ambiguous");
});

test("no terminal stopReason is ambiguous", () => {
  assert.equal(classify(out({}), ok).kind, "ambiguous");
});

test("aborted is transient", () => {
  assert.equal(classify(out({ stopReason: "aborted" }), ok).kind, "transient");
});

test("startup timeout is ambiguous (fails over but is not clean family-unavailability); overall timeout is transient", () => {
  // ambiguous, not model-unavailable: it still fails over, but an all-candidates startup-stall must
  // surface as exit 1, not exit 4 "family unavailable".
  assert.equal(classify(out({}), { startupTimedOut: true, overallTimedOut: false }).kind, "ambiguous");
  assert.equal(classify(out({}), { startupTimedOut: false, overallTimedOut: true }).kind, "transient");
});

// Nonce-aware classify tests (Task 3)

test("clean stop + noncePresent:true -> success", () => {
  assert.deepEqual(classify(out({ stopReason: "stop" }), ok, true), { kind: "success" });
});

test("clean stop + noncePresent:false -> incomplete", () => {
  const v = classify(out({ stopReason: "stop" }), ok, false);
  assert.equal(v.kind, "incomplete");
});

test("length stop + noncePresent:false -> incomplete", () => {
  const v = classify(out({ stopReason: "length" }), ok, false);
  assert.equal(v.kind, "incomplete");
});

test("clean stop + noncePresent:undefined (nonce disabled) -> success (Spec B parity)", () => {
  assert.deepEqual(classify(out({ stopReason: "stop" }), ok), { kind: "success" });
});

test("noncePresent is ignored for a non-stop error verdict", () => {
  const v = classify(out({ stopReason: "error", model: "m", errorMessage: "404 not_found_error" }), ok, false);
  assert.equal(v.kind, "model-unavailable");
});

// D10: pin pi 0.80.3's real "<status>: <body-json>" error shape (colon-form from NanoGPT)

test("0.80.3 colon-form: 400 model_not_supported -> model-unavailable", () => {
  const msg = `400: {"message":"Model \`gpt-foo\` is not supported for provider \\"nanogpt\\".","code":"model_not_supported","param":"model"}`;
  const v = classify(out({ stopReason: "error", model: "gpt-foo", errorMessage: msg }), ok, false);
  assert.equal(v.kind, "model-unavailable");
});

test("0.80.3 colon-form: 401 invalid_api_key -> fatal", () => {
  const msg = `401: {"message":"Invalid session","type":"invalid_api_key","code":"invalid_api_key","status":401}`;
  const v = classify(out({ stopReason: "error", errorMessage: msg }), ok, false);
  assert.equal(v.kind, "fatal");
});

test("0.80.3 colon-form: 429 rate_limit -> transient", () => {
  const msg = `429: {"message":"Rate limit exceeded","code":"rate_limit_exceeded"}`;
  const v = classify(out({ stopReason: "error", errorMessage: msg }), ok, false);
  assert.equal(v.kind, "transient");
});

// D11: 0.80.10 fast-forward — new pi builds openai-completions errorMessage via
// formatProviderError(normalizeProviderError(error)) in packages/ai/src/utils/error-body.ts
// (call site packages/ai/src/api/openai-completions.ts:496, no prefix). The no-prefix branch
// emits colon-form `"<status>: <body>"` where <body> = safeJsonStringify of the SDK's parsed
// error body. These cases cover the gaps beyond the existing 400/401/429 colon-form pins.

test("DS4 context-overflow colon-form (400) -> fatal (no model ref, must not fail over)", () => {
  // Message string from packages/ai/src/utils/overflow.ts DS4 pattern:
  //   /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i
  // surfaced through error-body.ts colon-form. Body has NO model reference, so the same
  // oversized prompt recurs identically on every candidate -> fatal, NOT failover/exit 4.
  const msg = `400: {"message":"Prompt has 163840 tokens, but the configured context size is 131072 tokens","type":"invalid_request_error","code":"invalid_request_error"}`;
  const v = classify(out({ stopReason: "error", model: "deepseek-ai/DeepSeek-V4", errorMessage: msg }), ok, false);
  assert.equal(v.kind, "fatal");
});

test("colon-form: 402 insufficient balance -> fatal (parseStatus on '402: {json}')", () => {
  // error-body.ts colon-form; confirms parseStatus's `^\s*(\d{3})\b` reads the status when the
  // separator is ': ' rather than a space.
  const msg = `402: {"message":"Insufficient balance","code":"insufficient_balance"}`;
  const v = classify(out({ stopReason: "error", errorMessage: msg }), ok, false);
  assert.equal(v.kind, "fatal");
});

test("colon-form: 403 key/endpoint forbidden, no model ref -> fatal", () => {
  // error-body.ts colon-form. A key-level 403 shares the same key across candidates -> fatal.
  const msg = `403: {"message":"Forbidden","type":"permission_error","code":"permission_denied"}`;
  const v = classify(out({ stopReason: "error", errorMessage: msg }), ok, false);
  assert.equal(v.kind, "fatal");
});

test("colon-form: 403 with the launched model id in the body -> model-unavailable", () => {
  // error-body.ts colon-form; modelReferenced fires via errorMessage.includes(launchedId),
  // routing an account/plan-gated model to failover (exit 4), not fatal.
  const msg = `403: {"message":"Model deepseek-ai/DeepSeek-V4 is not available on your plan","code":"model_forbidden"}`;
  const v = classify(out({ stopReason: "error", model: "deepseek-ai/DeepSeek-V4", errorMessage: msg }), ok, false);
  assert.equal(v.kind, "model-unavailable");
});

test("colon-form: 404 not_found -> model-unavailable", () => {
  const msg = `404: {"message":"Not found","type":"not_found_error","code":"not_found"}`;
  const v = classify(out({ stopReason: "error", errorMessage: msg }), ok, false);
  assert.equal(v.kind, "model-unavailable");
});

test("colon-form: 502 upstream -> transient (5xx via '502: {json}')", () => {
  const msg = `502: {"message":"Bad gateway","code":"upstream_error"}`;
  const v = classify(out({ stopReason: "error", errorMessage: msg }), ok, false);
  assert.equal(v.kind, "transient");
});

test("colon-form: 400 with the launched model id in the body (pure .includes branch) -> model-unavailable", () => {
  // No `model_not_supported` keyword here — disambiguation rides solely on
  // errorMessage.includes(launchedId).
  const msg = `400: {"message":"The requested model gpt-foo/bar cannot serve this request.","code":"invalid_request_error"}`;
  const v = classify(out({ stopReason: "error", model: "gpt-foo/bar", errorMessage: msg }), ok, false);
  assert.equal(v.kind, "model-unavailable");
});

test("colon-form: 400 request-shaped, no model ref -> fatal", () => {
  // error-body.ts colon-form; a malformed-request 400 recurs identically on every candidate -> fatal.
  const msg = `400: {"message":"messages: field required","type":"invalid_request_error","code":"invalid_request_error"}`;
  const v = classify(out({ stopReason: "error", errorMessage: msg }), ok, false);
  assert.equal(v.kind, "fatal");
});

test("bare 'Connection error.' (no status/body) -> ambiguous (fails over)", () => {
  // error-body.ts formatProviderError returns norm.message unchanged when no status/body was
  // extracted; a connection error stays bare. parseStatus finds no leading status -> ambiguous.
  const v = classify(out({ stopReason: "error", errorMessage: "Connection error." }), ok, false);
  assert.equal(v.kind, "ambiguous");
});

test("colon-form: 413 request-entity-too-large -> fatal (oversized prompt recurs on every candidate)", () => {
  // LIVE-CAPTURED against pi 0.80.10 + NanoGPT on deepseek/deepseek-v4-pro-cheaper:thinking.
  // DS4's context is 1,048,576 tokens, so a prompt big enough to overflow it is also big enough to
  // trip NanoGPT's request-body limit -> the server answers 413 BEFORE any context check (the
  // 400 context_length_exceeded path is unreachable on large-context models). The oversized
  // request is identical for every candidate, so failing over only burns the remaining ones.
  const msg = `413: {"code":"413","message":"Request Entity Too Large"}`;
  const v = classify(
    out({ stopReason: "error", model: "deepseek/deepseek-v4-pro-cheaper:thinking", errorMessage: msg }),
    ok,
    false,
  );
  assert.equal(v.kind, "fatal");
});
