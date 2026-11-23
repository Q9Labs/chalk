import { afterEach, expect, it, vi } from "vitest";
import type { ScreenAnnotationState } from "./index";
import { AnnotationReplica } from "./replica";

const layerId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c21";
const layer = { layer_id: layerId, publication_id: "screen", sharer_id: layerId, frame: { width: 1280, height: 720 } };
const state: ScreenAnnotationState = {
  layer,
  fence: 1,
  revision: 1,
  paused: false,
  marks: [],
  access: { draw_policy: "everyone", default_color: "#ff00ff", can_draw: true, can_moderate: true, can_manage_policy: true, requests: [] },
};
const target = { layerId, fence: 1 };
const cursor = (x: number) => ({ tool: "ink" as const, point: { x, y: 20 } });

function liveReplica() {
  const outbound: unknown[] = [];
  const replica = new AnnotationReplica((frame) => {
    outbound.push(JSON.parse(frame));
    return true;
  });
  replica.enterLive(true);
  replica.receive({ type: "annotation_state", state, server_at_ms: Date.now() });
  outbound.length = 0;
  return { replica, outbound };
}

afterEach(() => {
  vi.useRealTimers();
});

it("sends the first preview immediately and only the latest update in the next send slot", () => {
  vi.useFakeTimers();
  const { replica, outbound } = liveReplica();

  replica.setPresence(target, cursor(10), null);
  expect(outbound).toMatchObject([{ type: "annotation_presence", cursor: cursor(10) }]);

  vi.advanceTimersByTime(10);
  replica.setPresence(target, cursor(30), null);
  vi.advanceTimersByTime(10);
  replica.setPresence(target, cursor(50), null);
  vi.advanceTimersByTime(13);
  expect(outbound).toHaveLength(1);
  vi.advanceTimersByTime(1);
  expect(outbound).toMatchObject([
    { type: "annotation_presence", cursor: cursor(10) },
    { type: "annotation_presence", cursor: cursor(50) },
  ]);
});

it("does not flush a queued preview once its fence has been retired", () => {
  vi.useFakeTimers();
  const { replica, outbound } = liveReplica();
  replica.setPresence(target, cursor(10), null);
  replica.setPresence(target, cursor(20), null);
  outbound.length = 0;

  replica.receive({ type: "annotation_changed", layer_id: layerId, fence: 2, revision: 2, server_at_ms: Date.now(), change: { kind: "clear", participant_id: null } });
  vi.runAllTimers();
  expect(outbound).toEqual([]);
});

it("withdraws tools and burn-in while annotation is off without losing the live connection", async () => {
  const outbound: unknown[] = [];
  const replica = new AnnotationReplica((frame) => {
    outbound.push(JSON.parse(frame));
    return true;
  });
  const live = { type: "annotation_state", state, server_at_ms: Date.now() } as const;
  replica.enterLive(true, true);
  replica.receive(live);
  expect(replica.burnInNegotiated).toBe(true);

  replica.receive({ ...live, state: null, enabled: false });
  expect(replica.getSnapshot()).toEqual({ status: "unavailable" });
  expect(replica.burnInNegotiated).toBe(false);
  const sent = outbound.length;
  expect(await replica.dispatch(target, { kind: "pause", paused: true })).toEqual({ kind: "unavailable" });
  expect(await replica.bind("another-share", layer.frame, true)).toEqual({ kind: "unavailable" });
  expect(outbound).toHaveLength(sent);

  replica.receive(live);
  expect(replica.getSnapshot()).toMatchObject({ status: "ready", state });
  expect(replica.burnInNegotiated).toBe(true);
});
