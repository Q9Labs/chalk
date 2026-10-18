// Sample visible playback counters at 4 Hz. Counters belong to a decoder
// generation, not the element: srcObject changes can reset them without a remount.
export function videoCounterDelta(previous, current) {
  const reset = current.totalVideoFrames < previous.totalVideoFrames || current.droppedVideoFrames < previous.droppedVideoFrames;
  return { frames: current.totalVideoFrames - (reset ? 0 : previous.totalVideoFrames), dropped: current.droppedVideoFrames - (reset ? 0 : previous.droppedVideoFrames), resets: Number(reset) };
}

export function installVideoQualityObserver(counterDelta) {
  let previous = new WeakMap();
  let frames = 0;
  let dropped = 0;
  let resets = 0;
  let samples = 0;
  const visible = (video) => {
    const box = video.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && box.right > 0 && box.left < innerWidth && box.bottom > 0 && box.top < innerHeight;
  };
  const collect = () => {
    for (const video of document.querySelectorAll("video")) {
      const current = video.getVideoPlaybackQuality();
      const last = previous.get(video) ?? { totalVideoFrames: 0, droppedVideoFrames: 0 };
      previous.set(video, current);
      if (!visible(video)) continue;
      const delta = counterDelta(last, current);
      frames += delta.frames;
      dropped += delta.dropped;
      resets += delta.resets;
      samples++;
    }
  };
  const reset = () => {
    previous = new WeakMap([...document.querySelectorAll("video")].map((video) => [video, video.getVideoPlaybackQuality()]));
    frames = 0;
    dropped = 0;
    resets = 0;
    samples = 0;
  };
  setInterval(collect, 250);
  window.__callVideoQuality = {
    reset,
    snapshot: () => {
      collect();
      return { frames, dropped, resets, samples };
    },
  };
}
