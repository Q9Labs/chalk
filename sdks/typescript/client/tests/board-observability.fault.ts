import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { ClockEstimator } from "../src/obs/clock";
import { createBrowserWebSocketFactory } from "../src/sync/browser";
import type { SyncWebSocketFactory } from "../src/sync/types";
import { createWhiteboardObservations } from "../src/whiteboard/observations";
import type { ChalkWhiteboardSummary, ChalkWhiteboardV1Event } from "../src/whiteboard/types";
import { ChalkWhiteboardV1Client } from "../src/whiteboard/v1-client";

const [fixturePath, outputPath] = process.argv.slice(2);
assert(fixturePath && outputPath);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  url: string;
  fault: "healthy" | "board.edit_not_committed" | "board.out_of_sync" | "board.draw_denied" | "board.snapshot_mismatch";
  tenant: string;
  episode: string;
  seats: { participant: string; token: string }[];
};

type Frame = { type: string; elements?: unknown[] };
type Intercept = (frame: Frame) => Frame | null;
const recordIds: Record<string, string> = {
  board_edit: "board.client_edit",
  board_delivery: "board.client_delivery",
  board_draw: "board.client_draw",
  board_snapshot: "board.client_snapshot",
  board_follow: "board.follow",
};
const rows: Record<string, unknown>[] = [];

function socketWith(intercept: Intercept): SyncWebSocketFactory {
  const factory = createBrowserWebSocketFactory();
  return {
    connect(url) {
      const socket = factory.connect(url);
      return {
        get onopen() { return socket.onopen; },
        set onopen(value) { socket.onopen = value; },
        get onclose() { return socket.onclose; },
        set onclose(value) { socket.onclose = value; },
        get onerror() { return socket.onerror; },
        set onerror(value) { socket.onerror = value; },
        get onmessage() { return socket.onmessage; },
        set onmessage(value) {
          socket.onmessage = value && ((message) => {
            assert.equal(typeof message.data, "string");
            const frame = intercept(JSON.parse(String(message.data)) as Frame);
            if (frame) value({ data: JSON.stringify(frame) });
          });
        },
        send: (wire) => socket.send(wire),
        close: (code, reason) => socket.close(code, reason),
      };
    },
  };
}

function peer(index: number, intercept: Intercept = (frame) => frame) {
  const seat = fixture.seats[index];
  assert(seat);
  const clock = new ClockEstimator({ mono: () => performance.now(), wall: Date.now });
  // The disposable Sync server and this driver share the host clock.
  const now = performance.now();
  clock.sample(now, now, Date.now());
  let summary: ChalkWhiteboardSummary | undefined;
  const observations = createWhiteboardObservations({
    sessionId: crypto.randomUUID(),
    record: ({ type, ...fields }) => rows.push({
      ...fields,
      event: recordIds[type],
      tenant_id: fixture.tenant,
      episode_id: fixture.episode,
      participant_id: seat.participant,
      generation: 1,
      event_id: crypto.randomUUID(),
    }),
  }, clock);
  const client = new ChalkWhiteboardV1Client({
    url: fixture.url,
    token: () => Promise.resolve(seat.token),
    webSocket: socketWith(intercept),
    files: { getDownloadUrl: () => Promise.reject(new Error("this scenario has no files")) },
    observations,
    onSummary: (value) => { summary = value; },
    ...(index === 0 && fixture.fault === "board.edit_not_committed"
      ? { pendingStore: { load: async () => [], put: async () => { throw new Error("injected pending-store refusal"); }, remove: async () => undefined } }
      : {}),
  });
  const ready = () => client.startSceneSubscription();
  const events: ChalkWhiteboardV1Event[] = [];
  return { client, ready, summary: () => summary, events, subscribe: () => client.subscribe((event) => events.push(event)) };
}

async function until(predicate: () => boolean, event: string) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await delay(20);
  }
  assert.fail(`did not receive ${event}`);
}

const from = Date.now();
const author = peer(0);
let dropped = false;
const viewer = peer(1, (frame) => {
  if (frame.type !== "update" || dropped || fixture.fault !== "board.out_of_sync") return frame;
  dropped = true;
  return null;
});
let truncated = false;
const late = peer(2, (frame) => {
  if (fixture.fault !== "board.snapshot_mismatch" || frame.type !== "snapshot_page" || !frame.elements?.length) return frame;
  truncated = true;
  return { ...frame, elements: frame.elements.slice(1) };
});
const peers = [author, viewer, late];
try {
  await Promise.all([author.ready(), viewer.ready()]);
  author.subscribe();
  viewer.subscribe();
  const scene = author.summary()?.sceneId;
  assert(scene);
  const draw = (peer: typeof author, id: string) =>
    peer.client.submitUpdate({
      sceneId: scene,
      syncAll: false,
      elements: [{ id, type: "rectangle", version: 1, versionNonce: 1, index: "a0", isDeleted: false, payload: { x: 0, y: 0, width: 100, height: 80 } }],
    });
  if (fixture.fault === "board.edit_not_committed") {
    await assert.rejects(() => draw(author, "failed-save"), /persist/);
    assert.equal(rows.some((row) => row.board_step === "sent"), false);
  } else {
    await draw(author, "first-rectangle");
    const second = await draw(author, "second-rectangle");
    await until(() => viewer.events.some((event) => event.type === "update" && event.revision === second.revision), "the second edit");
    assert.equal(dropped, fixture.fault === "board.out_of_sync");
    if (fixture.fault === "board.draw_denied") {
      await author.client.setDrawPolicy("hosts");
      await until(() => viewer.summary()?.canDraw === false, "the changed draw policy");
      await assert.rejects(async () => draw(viewer, "blocked"), /permission/);
    } else {
      const reply = await draw(viewer, "viewer-rectangle");
      await until(() => author.events.some((event) => event.type === "update" && event.revision === reply.revision), "the reply");
    }
    await late.ready();
    late.subscribe();
    const snapshot = late.events.find((event) => event.type === "snapshot");
    assert(snapshot);
    assert.equal(truncated, fixture.fault === "board.snapshot_mismatch");
    assert.equal(snapshot.elements.length, fixture.fault === "board.draw_denied" ? 2 : truncated ? 2 : 3);
  }
} finally {
  await Promise.all(peers.map(({ client }) => client.stopSceneSubscription()));
}
writeFileSync(outputPath, JSON.stringify({ from, to: Date.now(), rows }));
