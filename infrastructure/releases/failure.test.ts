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
  assert.match(text, /failed; no payload logged/);
  assert.doesNotMatch(text, /secret-token-123/);
  assert.doesNotMatch(await report(Effect.fail({ payload: "secret-token-456" })), /secret-token-456/);
});
