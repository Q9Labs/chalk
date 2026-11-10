// Event-based join render time for the SFU canary, recorded beside the 500 ms stats poll so the two stay comparable.

// Runs in a proof guest's page before it joins. Each time is performance.timeOrigin + performance.now(), the host clock
// the canary's own timer maps onto. A hidden muted <video> gives every remote camera track a frame callback; a remote audio
// track's first `unmute` is its first RTP packet. Only the first of each is kept: a join is done when both have arrived.
export function installRenderProbe() {
  const now = () => performance.timeOrigin + performance.now();
  const times = (window.proofRenderTimes = { video: null, audio: null });
  const NativePC = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends NativePC {
    constructor(...args) {
      super(...args);
      this.addEventListener("track", ({ track }) => {
        if (track.kind === "video") {
          const element = document.createElement("video");
          element.muted = true;
          element.playsInline = true;
          element.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none";
          element.srcObject = new MediaStream([track]);
          document.body.append(element);
          element.requestVideoFrameCallback(() => (times.video ??= now()));
          void element.play().catch(() => {});
        } else if (track.muted) track.addEventListener("unmute", () => (times.audio ??= now()), { once: true });
        else times.audio ??= now();
      });
    }
  };
}

// renderEventMs is the time from startedAtEpochMs until every page has presented a video frame and received audio, or null
// when a page never reported one of them.
export function renderEventMs(pageTimes, startedAtEpochMs) {
  const arrivals = pageTimes.flatMap((times) => [times?.video, times?.audio]);
  if (arrivals.length === 0 || arrivals.some((at) => typeof at !== "number")) return null;
  return Math.round(Math.max(...arrivals) - startedAtEpochMs);
}
