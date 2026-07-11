import { test } from "node:test";
import assert from "node:assert/strict";
import { mintNonce, buildSuffix, buildResumePrompt, noncePresent, stripSentinel } from "./nonce.ts";

test("mintNonce is 16 lowercase hex chars", () => {
  const n = mintNonce();
  assert.match(n, /^[0-9a-f]{16}$/);
  assert.notEqual(mintNonce(), mintNonce()); // effectively never collides
});

test("buildSuffix embeds the exact marker phrase and a do-not-write-to-file fence", () => {
  const s = buildSuffix("abc123abc123abcd");
  assert.match(s, /WORK COMPLETE abc123abc123abcd/);
  assert.match(s, /not write it to any file|Do NOT write it to any file/i);
});

test("buildResumePrompt is status-only: no diff/file/test words, carries the marker", () => {
  const p = buildResumePrompt("abc123abc123abcd");
  assert.match(p, /WORK COMPLETE abc123abc123abcd/);
  assert.doesNotMatch(p, /diff|git|test failure|files? written|missing/i);
});

test("noncePresent true only when the final text contains the exact marker", () => {
  const n = "deadbeefdeadbeef";
  assert.equal(noncePresent(`all done.\nWORK COMPLETE ${n}`, n), true);
  assert.equal(noncePresent(`  WORK COMPLETE ${n}  \n`, n), true); // trim-tolerant
  assert.equal(noncePresent("WORK COMPLETE 0000000000000000", n), false); // wrong nonce
  assert.equal(noncePresent("still working, no marker", n), false);
});

test("stripSentinel removes exactly the marker line, leaves the rest", () => {
  const n = "deadbeefdeadbeef";
  assert.equal(stripSentinel(`hello world\nWORK COMPLETE ${n}`, n), "hello world");
  assert.equal(stripSentinel("no marker here", n), "no marker here");
});
