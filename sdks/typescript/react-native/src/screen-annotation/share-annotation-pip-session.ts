import type { ScreenAnnotationClient, ScreenAnnotationFrameSize, SpaceSnapshot } from "@q9labsai/chalk-client";
import { createAnnotationPresenceTracker } from "@q9labsai/chalk-screen-annotation";
import { paintAnnotationPiP } from "./pip-paint";

type Ink = ReturnType<typeof paintAnnotationPiP>;

export type LocalPiPShare = { readonly trackId: string; readonly publicationId?: string; readonly participantId: string | null };
export type PiPShareSource = {
  getShare(): LocalPiPShare | null;
  subscribe(listener: () => void): () => void;
};

export interface AnnotationPiP {
  supported(): Promise<boolean>;
  start(sessionId: string, trackId: string, width: number, height: number, ink: Ink): Promise<boolean>;
  update(sessionId: string, width: number, height: number, ink: Ink): void;
  stop(sessionId: string): void;
  addListener(event: string): void;
  removeListeners(count: number): void;
}

export function localPiPShare(snapshot: Pick<SpaceSnapshot, "media" | "self">): LocalPiPShare | null {
  const { track, publicationId } = snapshot.media.screenShare;
  // Sync can lose the confirmed publication without stopping the local broadcast.
  if (track?.readyState !== "live" || !track.enabled) return null;
  return { trackId: track.id, publicationId, participantId: snapshot.self.participantId };
}

function previewRect(frame: ScreenAnnotationFrameSize) {
  const scale = 480 / Math.max(frame.width, frame.height);
  return { x: 0, y: 0, width: Math.max(2, Math.round(frame.width * scale)), height: Math.max(2, Math.round(frame.height * scale)) };
}

type Phase = "idle" | "starting" | "active";
type Controls = { readonly trackId: string | null; readonly phase: Phase };
type ActiveWindow = { readonly id: string; readonly trackId: string; phase: Exclude<Phase, "idle">; layerId: string; rect: ReturnType<typeof previewRect> };
const hidden: Controls = { trackId: null, phase: "idle" };
let nextSessionId = 0;

/** The broadcast owns the window; subscribing to the controls does not own it. */
export function createShareAnnotationPiPSession(source: PiPShareSource, client: ScreenAnnotationClient, native: AnnotationPiP) {
  const listeners = new Set<() => void>();
  const tracker = createAnnotationPresenceTracker();
  let controls = hidden;
  let supported = false;
  let next: ReturnType<typeof setTimeout> | undefined;
  let activeWindow: ActiveWindow | null = null;

  function matchingScene() {
    const share = source.getShare();
    const snapshot = client.getSnapshot();
    if (!share || snapshot.status !== "ready") return null;
    const { state } = snapshot;
    if (!state?.access.can_moderate || state.layer.burned_in || state.layer.publication_id !== share.publicationId || state.layer.sharer_id !== share.participantId) return null;
    return { trackId: share.trackId, state, presence: snapshot.presence };
  }

  function publish() {
    const trackId = activeWindow?.trackId ?? (supported ? (matchingScene()?.trackId ?? null) : null);
    const phase = activeWindow?.phase ?? "idle";
    if (controls.trackId === trackId && controls.phase === phase) return;
    controls = { trackId, phase };
    for (const listener of listeners) listener();
  }

  function close() {
    const closing = activeWindow;
    activeWindow = null;
    tracker.clear();
    clearTimeout(next);
    next = undefined;
    return closing;
  }

  function stop() {
    const closing = close();
    if (closing) native.stop(closing.id);
    publish();
  }

  function paint() {
    next = undefined;
    if (activeWindow?.phase !== "active") return;
    const scene = matchingScene();
    if (!scene || scene.trackId !== activeWindow.trackId) {
      // Keep the last frame while Sync recovers. A ready, confirmed share with
      // no matching scene has no ink we can display.
      if (client.getSnapshot().status === "ready" && source.getShare()?.publicationId) {
        tracker.clear();
        native.update(activeWindow.id, activeWindow.rect.width, activeWindow.rect.height, []);
      }
      return;
    }
    const now = client.serverNowMs();
    if (activeWindow.layerId !== scene.state.layer.layer_id) {
      tracker.clear();
      activeWindow.layerId = scene.state.layer.layer_id;
    }
    const presence = tracker.update(scene.presence, now);
    const rect = previewRect(scene.state.layer.frame);
    activeWindow.rect = rect;
    native.update(activeWindow.id, rect.width, rect.height, paintAnnotationPiP(rect, scene.state, presence, now));
    const expires = scene.state.marks.some((mark) => mark.expires_at_ms !== null && mark.expires_at_ms > now);
    if (presence.length || expires) next = setTimeout(paint, 100);
  }

  function observe() {
    if (activeWindow && activeWindow.trackId !== source.getShare()?.trackId) stop();
    if (activeWindow?.phase === "active") next ??= setTimeout(paint, 67);
    publish();
  }

  return {
    attach() {
      let attached = true;
      void native.supported().then(
        (available) => {
          if (!attached) return;
          supported = available;
          publish();
        },
        () => undefined,
      );
      const offShare = source.subscribe(observe);
      const offAnnotation = client.subscribe(observe);
      return () => {
        attached = false;
        offShare();
        offAnnotation();
        supported = false;
        stop();
      };
    },
    getSnapshot: () => controls,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stopped(sessionId: unknown) {
      if (activeWindow?.id !== sessionId) return;
      close();
      publish();
    },
    async start(): Promise<boolean | undefined> {
      if (!supported || activeWindow) return;
      const scene = matchingScene();
      if (!scene) return;
      const rect = previewRect(scene.state.layer.frame);
      const attempt: ActiveWindow = { id: String(++nextSessionId), trackId: scene.trackId, phase: "starting", layerId: scene.state.layer.layer_id, rect };
      activeWindow = attempt;
      publish();
      const ink = paintAnnotationPiP(rect, scene.state, scene.presence, client.serverNowMs());
      const started = await native.start(attempt.id, attempt.trackId, rect.width, rect.height, ink).catch(() => false);
      if (activeWindow !== attempt) return;
      if (!started) {
        close();
        publish();
        return false;
      }
      activeWindow.phase = "active";
      publish();
      paint();
      return true;
    },
    stop,
  };
}
