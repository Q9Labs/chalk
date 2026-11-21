import type { ScreenAnnotationHelperShare, ScreenAnnotationHelperStatus } from "@q9labsai/chalk-react";
import { HelperConflict, localRequest, readJson, type HelperPen } from "./screen-annotation-helper-bridge";
import { calibrateMonitor, calibrateWindow, chromiumWindowId, probeSchema } from "./screen-annotation-helper-calibration";

export function liveProjection({
  track,
  share,
  currentTrack,
  attachmentSecret,
  signal,
}: {
  readonly track: MediaStreamTrack | undefined;
  readonly share: ScreenAnnotationHelperShare;
  readonly currentTrack: () => MediaStreamTrack | undefined;
  readonly attachmentSecret: string;
  readonly signal: AbortSignal;
}) {
  const settings = track?.getSettings();
  const chromium = /(?:Chrome|Chromium)\//.test(navigator.userAgent);
  const monitor = chromium && share.surface === "monitor" && settings?.displaySurface === "monitor" && Boolean(settings.width && settings.height);
  const windowId = chromium && share.surface === "window" && settings?.displaySurface === "window" && track ? chromiumWindowId(track.label) : undefined;
  let verifiedWindowSize: { width: number; height: number } | undefined;
  let calibrated = false;
  let sending = false;
  let observed = false;
  let pushing = false;
  let checkWindowAfter = 0;
  const exchange = (data: object, timeout = 1500) => localRequest("/v1/exchange", AbortSignal.any([signal, AbortSignal.timeout(timeout)]), data, attachmentSecret);
  function checkSource() {
    const current = track?.getSettings();
    if (
      !track ||
      track !== currentTrack() ||
      track.readyState !== "live" ||
      !activeShare(share) ||
      (windowId ? current?.displaySurface !== "window" || chromiumWindowId(track.label) !== windowId : current?.displaySurface !== "monitor" || current.width !== settings?.width || current.height !== settings?.height)
    ) {
      throw new Error("The capture changed.");
    }
  }
  async function publish(): Promise<void> {
    if (!observed) return;
    checkSource();
    if (windowId && verifiedWindowSize) {
      const size = track?.getSettings();
      if (size?.width !== verifiedWindowSize.width || size.height !== verifiedWindowSize.height) {
        observed = false;
        await exchange({ type: "probe_abort" });
        return;
      }
    }
    const snapshot = share.client.getSnapshot();
    if (snapshot.status !== "ready" || !snapshot.state) throw new Error("The screen share is no longer active.");
    const { layer, marks, paused, fence, access } = snapshot.state;
    await exchange({
      type: "scene",
      layerId: layer.layer_id,
      publicationId: layer.publication_id,
      width: verifiedWindowSize?.width ?? settings?.width,
      height: verifiedWindowSize?.height ?? settings?.height,
      scene: { marks, presence: snapshot.presence, paused, fence, canDraw: access.can_draw, sharerId: layer.sharer_id, serverAtMs: Math.round(share.client.serverNowMs()) },
    });
  }
  function pushLatest(onError: (reason: unknown) => void) {
    let dirty = false;
    const flush = async () => {
      dirty = true;
      if (sending) return;
      sending = true;
      try {
        while (dirty && !signal.aborted) {
          dirty = false;
          await publish();
        }
      } catch (error) {
        // A concurrent native move/resize can hide the overlay before the
        // status event reaches the browser. Keep waiting for revalidation.
        if (windowId && error instanceof HelperConflict) {
          observed = false;
        } else if (!signal.aborted) onError(error);
      } finally {
        sending = false;
      }
    };
    const unsubscribe = share.client.subscribe(() => void flush());
    const heartbeat = setInterval(() => void flush(), 1500);
    signal.addEventListener(
      "abort",
      () => {
        clearInterval(heartbeat);
        unsubscribe();
      },
      { once: true },
    );
    void flush();
  }
  const failure = new AbortController();
  const failed = new Promise<void>((_, reject) => {
    failure.signal.addEventListener("abort", () => reject(failure.signal.reason), { once: true });
  });
  return {
    failure: failed,
    async commit(pen: HelperPen) {
      checkSource();
      const snapshot = share.client.getSnapshot();
      if (!observed || snapshot.status !== "ready" || !snapshot.state || snapshot.state.fence !== pen.fence || !snapshot.state.access.can_draw) return;
      await share.client.dispatch(
        { layerId: share.layer.layer_id, fence: pen.fence },
        {
          kind: "commit",
          draft: {
            mark_id: crypto.randomUUID(),
            lifetime: "fade",
            color: "#ffffff",
            width: pen.width,
            shape: { kind: "pen", points: pen.points },
          },
        },
      );
    },
    async describe() {
      await exchange({ type: "capture", surface: monitor ? "monitor" : windowId ? "window" : "unsupported", width: settings?.width ?? 1, height: settings?.height ?? 1, windowId });
    },
    async observe(status: ScreenAnnotationHelperStatus) {
      if (status === "calibrating" && !calibrated && monitor && track) {
        checkSource();
        calibrated = true;
        await calibrateMonitor({
          track,
          signal,
          start: (signal) => localRequest("/v1/exchange", signal, { type: "probe_start" }, attachmentSecret).then((response) => readJson(response, probeSchema)),
          protect: async (nonce, signal) => {
            await localRequest("/v1/exchange", signal, { type: "probe_protect", nonce }, attachmentSecret);
          },
          complete: async (nonce, signal) => {
            checkSource();
            await localRequest("/v1/exchange", signal, { type: "probe_complete", nonce }, attachmentSecret);
          },
          abort: async () => {
            await localRequest("/v1/exchange", AbortSignal.timeout(1500), { type: "probe_abort" }, attachmentSecret);
          },
        });
      } else if (status === "calibrating" && windowId && track) {
        observed = false;
        checkSource();
        if (performance.now() < checkWindowAfter) return;
        checkWindowAfter = performance.now() + 2200;
        let matchedSize: { width: number; height: number } | undefined;
        await calibrateWindow({
          track,
          signal,
          verify: async (input, probeSignal) => {
            const response = await localRequest("/v1/exchange", probeSignal, { type: "window_sample", ...input }, attachmentSecret);
            if (response.status !== 200) return false;
            matchedSize = { width: input.width, height: input.height };
            return true;
          },
          start: (probeSignal) => localRequest("/v1/exchange", probeSignal, { type: "window_probe_start" }, attachmentSecret).then((response) => readJson(response, probeSchema)),
          complete: async (nonce, probeSignal) => {
            checkSource();
            await localRequest("/v1/exchange", probeSignal, { type: "probe_complete", nonce }, attachmentSecret);
            verifiedWindowSize = matchedSize;
          },
          abort: async () => {
            await localRequest("/v1/exchange", AbortSignal.timeout(1500), { type: "probe_abort" }, attachmentSecret);
          },
        });
      } else if (status === "ready" && !observed) {
        observed = true;
        if (signal.aborted || pushing) return;
        pushing = true;
        pushLatest((reason) => failure.abort(reason));
      }
    },
  };
}

export function activeShare(share: ScreenAnnotationHelperShare): boolean {
  const snapshot = share.client.getSnapshot();
  const live = snapshot.status === "ready" ? snapshot.state?.layer : null;
  return Boolean(live && live.layer_id === share.layer.layer_id && live.publication_id === share.layer.publication_id && live.sharer_id === share.participantId);
}
