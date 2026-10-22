import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const { outputFiles } = await build({ entryPoints: [new URL("../consumer/media-client.ts", import.meta.url).pathname], bundle: true, platform: "node", format: "esm", write: false });
const { FixtureMediaClient } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`);

for (const source of ["microphone", "camera", "screen"]) {
  test(`absent ${source}: Stop is satisfied, but Enable is rejected`, async () => {
    const client = new FixtureMediaClient("ws://fixture.test/media", {
      access: { subject: { participantId: "self" }, media: { provider: "cloudflare_sfu", clientPayload: { connectionId: "fixture", stunServer: "stun:localhost:9" } } },
      credential: async () => "fixture",
      onFailure: assert.fail,
      onScreenEnded: assert.fail,
    });
    try {
      const target = { operationId: "fixture", participantId: "self", source };
      assert.deepEqual(await client.setLocalPublicationTarget({ ...target, enabled: false }), { outcome: "satisfied", errorCode: null });
      assert.deepEqual(await client.setLocalPublicationTarget({ ...target, enabled: true }), { outcome: "terminal_failure", errorCode: "source_unavailable" });
    } finally {
      client.stop();
    }
  });
}
