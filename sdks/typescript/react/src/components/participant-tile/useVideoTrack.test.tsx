// @vitest-environment happy-dom
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useVideoTrack } from "./useVideoTrack";

afterEach(() => vi.restoreAllMocks());

function Video({ track }: { readonly track: MediaStreamTrack | null }) {
  const ref = useRef<HTMLVideoElement>(null);
  const status = useVideoTrack(ref, track, true);
  return <video ref={ref} data-status={status} />;
}

it.each([false, true])("plays replacement video objects with the same ID, with an empty snapshot between: %s", async (emptySnapshot) => {
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  const previous = Object.assign(new EventTarget(), { id: "remote-video", kind: "video", readyState: "live", muted: false }) as MediaStreamTrack;
  const replacement = Object.assign(new EventTarget(), { id: previous.id, kind: "video", readyState: "live", muted: false }) as MediaStreamTrack;
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Video track={previous} />));
    const video = container.querySelector("video")!;
    await act(async () => video.dispatchEvent(new Event("loadeddata")));
    expect(video.dataset.status).toBe("playing");
    Object.assign(previous, { readyState: "ended" });
    if (emptySnapshot) await act(async () => root.render(<Video track={null} />));
    await act(async () => root.render(<Video track={replacement} />));
    expect((video.srcObject as MediaStream).getVideoTracks()).toEqual([replacement]);
    await act(async () => video.dispatchEvent(new Event("loadeddata")));
    await act(async () => previous.dispatchEvent(new Event("ended")));
    expect(video.dataset.status).toBe("playing");
    expect(play).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
  }
});
