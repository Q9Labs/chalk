import assert from "node:assert/strict";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import { refuse } from "../platform/refusal.ts";
import { reportFailure } from "./failure.ts";

// Runs reportFailure and returns what it wrote to stderr, restoring the process state afterwards.
async function report(effect: Effect.Effect<unknown, unknown>) {
  const exit = await Effect.runPromiseExit(effect);
  const written: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  const code = process.exitCode;
  process.stderr.write = (chunk: string | Uint8Array) => (written.push(String(chunk)), true);
  try {
    reportFailure(exit, "retirement");
  } finally {
    process.stderr.write = write;
    process.exitCode = code;
  }
  return written.join("");
}

test("a refusal prints its reason on stderr", async () => {
  assert.equal(await report(refuse("Record Cdn is not expected; retirement refused")), "Infrastructure retirement refused: Record Cdn is not expected; retirement refused\n");
});

test("an unknown failure and a defect keep their payload hidden", async () => {
  const text = await report(Effect.die("secret-token-123"));
  assert.match(text, /failed \(defect unclassified\); no payload logged/);
  assert.doesNotMatch(text, /secret-token-123/);
  assert.doesNotMatch(await report(Effect.fail({ payload: "secret-token-456" })), /secret-token-456/);
});

test("an unexpected failure names its class or tag and the operation, never its message", async () => {
  class ProviderError extends Error {}
  const text = await report(Effect.die(new ProviderError("arn:aws:iam::123456789012:role/private")));
  assert.equal(text, "Infrastructure retirement failed (defect ProviderError); no payload logged. Set CHALK_ALCHEMY_DIAGNOSTICS for private diagnostics.\n");
  assert.match(await report(Effect.fail({ _tag: "ThrottlingException", message: "account 123456789012" })), /\(error ThrottlingException\)/);
  assert.match(await report(Effect.fail({ _tag: "not a name 123456789012" })), /\(error unclassified\)/);
});
