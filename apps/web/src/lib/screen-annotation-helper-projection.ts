import type { ScreenAnnotationHelperShare, ScreenAnnotationHelperStatus } from "@q9labsai/chalk-react";
import { HelperConflict, delay, localRequest, readJson } from "./screen-annotation-helper-bridge";
import { calibrateMonitor, calibrateWindow, probeSchema } from "./screen-annotation-helper-calibration";
import { chromiumWindowId, classifyHelperCapture } from "./screen-annotation-helper-capture";

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
  const { settings, monitor, windowId } = classifyHelperCapture(share.surface, track, navigator.userAgent);
  let verifiedWindowSize: { width: number; height: number } | undefined;
  let calibrated = false;
  const sourceLabel = track?.label;
  let checkWindowAfter = 0;
  const exchange = (data: object, timeout = 1500) => localRequest("/v1/exchange", AbortSignal.any([signal, AbortSignal.timeout(timeout)]), data, attachmentSecret);
  function checkSource() {
    const current = track?.getSettings();
    if (
      !track ||
      track !== currentTrack() ||
      track.readyState !== "live" ||
      !activeShare(share) ||
      track.label !== sourceLabel ||
      (windowId ? current?.displaySurface !== "window" || chromiumWindowId(track.label) !== windowId : current?.displaySurface !== "monitor" || current.width !== settings?.width || current.height !== settings?.height || current.deviceId !== settings?.deviceId)
    ) {
      throw new Error("The capture changed.");
    }
  }
  async function painted(nonce: string, attempt: AbortSignal) {
    while (!attempt.aborted) {
      try {
        await localRequest("/v1/exchange", attempt, { type: "probe_painted", nonce }, attachmentSecret);
        return;
      } catch (error) {
        if (!(error instanceof HelperConflict)) throw error;
        await delay(32, attempt);
      }
    }
    attempt.throwIfAborted();
  }
  const failure = (async () => {
    while (!signal.aborted) {
      await delay(240, signal);
      if (signal.aborted) return;
      if (!track || (!monitor && !windowId)) continue;
      checkSource();
      if (windowId && verifiedWindowSize) {
        const { width, height } = track.getSettings();
        if (width !== verifiedWindowSize.width || height !== verifiedWindowSize.height) {
          verifiedWindowSize = undefined;
          await exchange({ type: "probe_abort" });
        }
      }
    }
  })();
  return {
    failure,
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
            await painted(nonce, signal);
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
          painted,
          complete: async (nonce, probeSignal) => {
            checkSource();
            await localRequest("/v1/exchange", probeSignal, { type: "probe_complete", nonce }, attachmentSecret);
            verifiedWindowSize = matchedSize;
          },
          abort: async () => {
            await localRequest("/v1/exchange", AbortSignal.timeout(1500), { type: "probe_abort" }, attachmentSecret);
          },
        });
      }
    },
  };
}

export function activeShare(share: ScreenAnnotationHelperShare): boolean {
  const snapshot = share.client.getSnapshot();
  const live = snapshot.status === "ready" ? snapshot.state?.layer : null;
  return Boolean(live && live.layer_id === share.layer.layer_id && live.publication_id === share.layer.publication_id && live.sharer_id === share.participantId);
}
