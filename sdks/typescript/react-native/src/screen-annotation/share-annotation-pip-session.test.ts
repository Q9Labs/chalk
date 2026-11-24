import type { ScreenAnnotationClient, ScreenAnnotationSnapshot, ScreenAnnotationState } from "@q9labsai/chalk-client";
import { expect, it, vi } from "vitest";
import { createShareAnnotationPiPSession, type AnnotationPiP, type LocalPiPShare } from "./share-annotation-pip-session";

it("keeps the window and last ink across a controls remount and Sync recovery on the same broadcast", async () => {
  vi.useFakeTimers();
  try {
    const trackId = "replaykit-track";
    const state: ScreenAnnotationState = {
      layer: { layer_id: "share-layer", publication_id: "share", sharer_id: "sharer", frame: { width: 1600, height: 1000 } },
      fence: 1,
      revision: 1,
      paused: false,
      access: { can_draw: true, can_moderate: true, can_manage_policy: true, default_color: "#43dd8b", draw_policy: "everyone", requests: [] },
      marks: [],
    };
    let share: LocalPiPShare | null = { trackId, publicationId: "share", participantId: "sharer" };
    const viewerPresence = (display_name: string) => ({
      author: { participant_id: "viewer", display_name, color: "#43dd8b" },
      cursor: { tool: "ink" as const, point: { x: 1000, y: 1000 } },
      draft: null,
      server_at_ms: 100,
      expires_at_ms: 500,
    });
    let snapshot: ScreenAnnotationSnapshot = { status: "ready", state, presence: [viewerPresence("Maya")] };
    const listeners = new Set<() => void>();
    const subscribe = (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    const client: ScreenAnnotationClient = {
      getSnapshot: () => snapshot,
      subscribe,
      serverNowMs: () => 100,
      dispatch: async () => ({ kind: "unavailable" }),
      setPresence: () => undefined,
    };
    type Ink = Parameters<AnnotationPiP["update"]>[3];
    type NativeWindow = { id: string; track: string; frame: { width: number; height: number; ink: Ink } };
    const device: { window: NativeWindow | null } = { window: null };
    const native: AnnotationPiP = {
      supported: async () => true,
      async start(id, track, width, height, ink) {
        device.window = { id, track, frame: { width, height, ink } };
        return true;
      },
      update(id, width, height, ink) {
        if (device.window?.id === id) device.window.frame = { width, height, ink };
      },
      stop(id) {
        if (device.window?.id === id) device.window = null;
      },
      addListener: () => undefined,
      removeListeners: () => undefined,
    };
    const session = createShareAnnotationPiPSession({ getShare: () => share, subscribe }, client, native);
    const detach = session.attach();
    await Promise.resolve();
    const unmountControls = session.subscribe(() => undefined);
    expect(await session.start()).toBe(true);
    const nativeWindow = device.window;
    const lastFrame = nativeWindow?.frame;
    expect(nativeWindow?.track).toBe(trackId);
    expect(lastFrame?.ink).toEqual(expect.arrayContaining([expect.arrayContaining(["text", "Maya"])]));

    unmountControls();
    share = { trackId, participantId: "sharer" };
    snapshot = { status: "connecting" };
    for (const listener of listeners) listener();
    await vi.advanceTimersByTimeAsync(150);
    expect(device.window).toBe(nativeWindow);
    expect(device.window?.frame).toBe(lastFrame);

    const unmountRecoveredControls = session.subscribe(() => undefined);
    expect(session.getSnapshot()).toEqual({ trackId, phase: "active" });
    share = { trackId, publicationId: "new-publication", participantId: "sharer" };
    snapshot = {
      status: "ready",
      state: { ...state, layer: { ...state.layer, publication_id: share.publicationId, layer_id: "rebound-layer" } },
      presence: [viewerPresence("Omar")],
    };
    for (const listener of listeners) listener();
    await vi.advanceTimersByTimeAsync(100);
    expect(device.window).toBe(nativeWindow);
    expect(device.window?.frame).toEqual({ width: 480, height: 300, ink: expect.arrayContaining([expect.arrayContaining(["text", "Omar"])]) });

    share = null;
    for (const listener of listeners) listener();
    expect(device.window).toBeNull();
    expect(session.getSnapshot()).toEqual({ trackId: null, phase: "idle" });
    unmountRecoveredControls();
    detach();
  } finally {
    vi.useRealTimers();
  }
});
