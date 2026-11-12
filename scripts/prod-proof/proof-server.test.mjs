import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { test } from "node:test";
import { ProofError, publicFailure } from "./runtime.mjs";
import { proofServer } from "./webhooks.mjs";

async function holdPort() {
  const holder = createServer();
  holder.listen(0, "127.0.0.1");
  await once(holder, "listening");
  const { port } = holder.address();
  return { port, release: () => new Promise((done) => holder.close(done)) };
}
const runOn = (port) => ({ config: { proof_origin: `http://127.0.0.1:${port}` }, resources: [] });

test("a proof that finds the proof origin in use serves it once the other proof lets go", async () => {
  const held = await holdPort();
  const run = runOn(held.port);
  const serving = proofServer(run, { waitMs: 5000, pollMs: 20 });
  setTimeout(() => void held.release(), 100);
  const receiver = await serving;
  assert.equal(receiver.origin, `http://127.0.0.1:${held.port}`);
  await run.resources[0].dispose();
});

test("a proof origin that stays in use fails with the named reason proof-origin-busy", async () => {
  const held = await holdPort();
  const lines = [];
  await assert.rejects(proofServer(runOn(held.port), { waitMs: 100, pollMs: 20 }), (error) => {
    publicFailure("setup-or-capture", error, (line) => lines.push(line));
    return error instanceof ProofError;
  });
  assert.deepEqual(lines, ["PROOF setup-or-capture: failed (proof-origin-busy)"]);
  await held.release();
});
