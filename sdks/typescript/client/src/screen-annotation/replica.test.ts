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

afterEach(() => vi.useRealTimers());

it("sends the first preview immediately and only the latest update in the next send slot", () => {
  vi.useFakeTimers();
  const send = vi.fn<(frame: string) => boolean>().mockReturnValue(true);
  const replica = new AnnotationReplica(send);
  replica.enterLive(true);
  replica.receive({ type: "annotation_state", state, server_at_ms: Date.now() });
  send.mockClear();

  replica.setPresence(target, cursor(10), null);
  expect(send).toHaveBeenCalledTimes(1);
  expect(JSON.parse(send.mock.calls[0]![0])).toMatchObject({ type: "annotation_presence", cursor: cursor(10) });

  vi.advanceTimersByTime(10);
  replica.setPresence(target, cursor(30), null);
  vi.advanceTimersByTime(10);
  replica.setPresence(target, cursor(50), null);
  vi.advanceTimersByTime(13);
  expect(send).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1);
  expect(send).toHaveBeenCalledTimes(2);
  expect(JSON.parse(send.mock.calls[1]![0])).toMatchObject({ type: "annotation_presence", cursor: cursor(50) });
});

it("does not flush a queued preview once its fence has been retired", () => {
  vi.useFakeTimers();
  const send = vi.fn<(frame: string) => boolean>().mockReturnValue(true);
  const replica = new AnnotationReplica(send);
  replica.enterLive(true);
  replica.receive({ type: "annotation_state", state, server_at_ms: Date.now() });
  replica.setPresence(target, cursor(10), null);
  replica.setPresence(target, cursor(20), null);
  send.mockClear();

  replica.receive({ type: "annotation_changed", layer_id: layerId, fence: 2, revision: 2, server_at_ms: Date.now(), change: { kind: "clear", participant_id: null } });
  vi.runAllTimers();
  expect(send).not.toHaveBeenCalled();
});
