import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { movingLayers, proveLayers } from "./media.mjs";
import { cleanupRun } from "./runtime.mjs";
import { checkShareProgress, episodeEnd } from "./proofs.mjs";
import { proofServer } from "./webhooks.mjs";
import { createServer } from "node:net";
import { once } from "node:events";

const outbound = (rid, framesEncoded, connection = 0) => ({ id: `send-${rid}`, connection, type: "outbound-rtp", kind: "video", camera: true, rid, framesEncoded });
const incoming = (frameWidth, framesDecoded) => ({ id: "camera-receive", connection: 0, type: "inbound-rtp", kind: "video", source: "camera", frameWidth, framesDecoded });

test("unchanged counters and another peer connection do not prove a moving layer", () => {
  assert.deepEqual(movingLayers([outbound("f", 30)], [outbound("f", 30), outbound("f", 60, 1)]), []);
});
test("sender acknowledgement without inbound resolution change cannot pass", async () => {
  const before = [[outbound("q", 10), outbound("h", 10), outbound("f", 10)], [incoming(1280, 100)]];
  const after = [[outbound("q", 20), outbound("h", 10), outbound("f", 10)], [incoming(1280, 120)]];
  await assert.rejects(proveLayers({}, { before, after, limited: true }), /No inbound resolution/);
});
test("resolution change without live low-layer packets cannot pass", async () => {
  const before = [[outbound("q", 10)], [incoming(1280, 100)]];
  const after = [[outbound("q", 10)], [incoming(320, 120)]];
  await assert.rejects(proveLayers({}, { before, after, limited: true }), /Low layer stopped/);
});
test("a frozen screen share cannot pass on a lone decoded frame", () => {
  const screen = (framesDecoded, connection = 0) => [{ id: "screen", source: "screen", framesDecoded, connection }];
  assert.throws(() => checkShareProgress(screen(100), screen(101)), /decoding stalled/);
  assert.throws(() => checkShareProgress(screen(100), screen(200, 1)), /decoding stalled/);
  checkShareProgress(screen(100), screen(200));
});
test("a crashed guest falls back to the owner end endpoint and waits for durability", async () => {
  const calls = [];
  const ending = episodeEnd(
    {
      ownerRequest: async (method, path) => {
        calls.push([method, path]);
        return { status: "ended" };
      },
    },
    "/episode",
  );
  ending.useSDK({
    evaluate: async () => {
      throw new Error("page closed");
    },
  });
  await ending.end();
  await ending.end();
  assert.deepEqual(calls, [
    ["POST", "/episode/end"],
    ["GET", "/episode"],
    ["GET", "/episode"],
  ]);
});
test("fixture server preserves a localhost origin for exact-match CORS", async () => {
  const portProbe = createServer().listen(0, "127.0.0.1");
  await once(portProbe, "listening");
  const port = portProbe.address().port;
  await new Promise((resolve) => portProbe.close(resolve));
  const run = { config: { proof_origin: `http://localhost:${port}` }, resources: [] };
  const receiver = await proofServer(run);
  try {
    assert.equal(receiver.origin, run.config.proof_origin);
    assert.equal((await fetch(receiver.origin)).status, 200);
  } finally {
    await run.resources[0].dispose();
  }
});
test("cleanup continues after a failed resource and reports the failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chalk-proofkit-test-"));
  const disposed = [];
  const run = {
    directory,
    cleanup: [],
    resources: [
      {
        kind: "key",
        dispose: async () => {
          disposed.push("key");
        },
      },
      {
        kind: "episode",
        dispose: async () => {
          disposed.push("episode");
          throw new Error("end failed");
        },
      },
    ],
    ownerRequest: async () => {
      disposed.push("logout");
    },
  };
  try {
    await assert.rejects(cleanupRun(run), /Run cleanup failed/);
    assert.deepEqual(disposed, ["episode", "key", "logout"]);
    assert.equal(JSON.parse(await readFile(join(directory, "cleanup.json"), "utf8"))[0].result, "failed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
