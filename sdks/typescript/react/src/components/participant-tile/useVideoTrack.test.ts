// @vitest-environment happy-dom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useVideoTrack, type VideoTrackStatus } from "./useVideoTrack";

class FakeMediaStreamTrack extends EventTarget implements MediaStreamTrack {
  readonly contentHint = "";
  enabled = true;
  readonly id: string;
  readonly kind: "video" = "video";
  readonly label = "Fake camera";
  muted: boolean;
  onended: MediaStreamTrack["onended"] = null;
  onmute: MediaStreamTrack["onmute"] = null;
  onunmute: MediaStreamTrack["onunmute"] = null;
  readyState: MediaStreamTrackState;

  constructor(id: string, readyState: MediaStreamTrackState = "live", muted = false) {
    super();
    this.id = id;
    this.readyState = readyState;
    this.muted = muted;
  }

  applyConstraints(_constraints?: MediaTrackConstraints): Promise<void> {
    return Promise.resolve();
  }

  clone(): MediaStreamTrack {
    return new FakeMediaStreamTrack(`${this.id}-clone`, this.readyState, this.muted);
  }

  getCapabilities(): MediaTrackCapabilities {
    return {};
  }

  getConstraints(): MediaTrackConstraints {
    return {};
  }

  getSettings(): MediaTrackSettings {
    return {};
  }

  stop(): void {
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
  }
}

class FakeMediaStream {
  static instances: FakeMediaStream[] = [];
  readonly tracks: MediaStreamTrack[];

  constructor(tracks: MediaStreamTrack[]) {
    this.tracks = tracks;
    FakeMediaStream.instances.push(this);
  }
}

interface VideoFixture {
  readonly video: HTMLVideoElement;
  readonly getSource: () => unknown;
  readonly play: ReturnType<typeof vi.fn>;
}

function createVideoFixture(play: () => Promise<void>): VideoFixture {
  const video = document.createElement("video");
  let source: unknown = null;
  Object.defineProperty(video, "srcObject", {
    configurable: true,
    get: () => source,
    set: (value: unknown) => {
      source = value;
    },
  });
  const playSpy = vi.fn(play);
  Object.defineProperty(video, "play", { configurable: true, value: playSpy });
  return { video, getSource: () => source, play: playSpy };
}

function renderVideoTrack(video: HTMLVideoElement, track: MediaStreamTrack | null, enabled = true) {
  const videoRef = { current: video };
  return renderHook(({ currentTrack, currentEnabled }: { currentTrack: MediaStreamTrack | null; currentEnabled: boolean }) => useVideoTrack(videoRef, currentTrack, currentEnabled), {
    initialProps: { currentTrack: track, currentEnabled: enabled },
  });
}

afterEach(() => {
  cleanup();
  FakeMediaStream.instances = [];
  vi.unstubAllGlobals();
});

describe("useVideoTrack", () => {
  it("attaches a live track and transitions through rendered, muted, and ended states", () => {
    vi.stubGlobal("MediaStream", FakeMediaStream);
    const fixture = createVideoFixture(() => Promise.resolve());
    const track = new FakeMediaStreamTrack("remote-camera");
    const { result } = renderVideoTrack(fixture.video, track);

    expect(result.current).toBe<VideoTrackStatus>("loading");
    expect(fixture.getSource()).toBe(FakeMediaStream.instances[0]);
    expect(FakeMediaStream.instances[0]?.tracks).toEqual([track]);
    expect(fixture.play).toHaveBeenCalledOnce();

    act(() => fixture.video.dispatchEvent(new Event("loadeddata")));
    expect(result.current).toBe("playing");

    act(() => {
      track.muted = true;
      track.dispatchEvent(new Event("mute"));
    });
    expect(result.current).toBe("muted");

    act(() => {
      track.muted = false;
      track.dispatchEvent(new Event("unmute"));
    });
    expect(result.current).toBe("playing");

    act(() => {
      track.readyState = "ended";
      track.dispatchEvent(new Event("ended"));
    });
    expect(result.current).toBe("ended");
  });

  it("reports playback failures and ignores an abort from superseded playback", async () => {
    vi.stubGlobal("MediaStream", FakeMediaStream);
    const fixture = createVideoFixture(() => Promise.reject(new Error("autoplay blocked")));
    const track = new FakeMediaStreamTrack("remote-camera");
    const { result } = renderVideoTrack(fixture.video, track);

    await act(async () => undefined);
    expect(result.current).toBe("error");

    cleanup();
    const abortFixture = createVideoFixture(() => Promise.reject(new DOMException("superseded", "AbortError")));
    const abortTrack = new FakeMediaStreamTrack("remote-camera-abort");
    const abortResult = renderVideoTrack(abortFixture.video, abortTrack);

    await act(async () => undefined);
    expect(abortResult.result.current).toBe("loading");
  });

  it("clears the element when disabled, when the track is not live, and on cleanup", () => {
    vi.stubGlobal("MediaStream", FakeMediaStream);
    const fixture = createVideoFixture(() => Promise.resolve());
    const track = new FakeMediaStreamTrack("remote-camera");
    const hook = renderVideoTrack(fixture.video, track, false);

    expect(hook.result.current).toBe("idle");
    expect(fixture.getSource()).toBeNull();
    expect(fixture.play).not.toHaveBeenCalled();

    hook.rerender({ currentTrack: track, currentEnabled: true });
    expect(hook.result.current).toBe("loading");
    expect(fixture.getSource()).toBe(FakeMediaStream.instances[0]);

    hook.rerender({ currentTrack: new FakeMediaStreamTrack("ended-camera", "ended"), currentEnabled: true });
    expect(hook.result.current).toBe("idle");
    expect(fixture.getSource()).toBeNull();

    hook.unmount();
    expect(fixture.getSource()).toBeNull();
  });
});
