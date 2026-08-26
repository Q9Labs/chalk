// @vitest-environment happy-dom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChalkProvider } from "../../bindings/context";
import { createFakeMediaStreamTrack } from "../../test-support/fake-media-track";
import { createTestClient } from "../../test-support/test-client";
import { AudioOutput, type AudioParticipant } from "./AudioOutput";

afterEach(() => {
  cleanup();
  FakeAudio.instances = [];
  vi.unstubAllGlobals();
});

class FakeAudio {
  static instances: FakeAudio[] = [];
  autoplay = false;
  muted = false;
  srcObject: MediaStream | null = null;
  play = vi.fn(async () => undefined);
  pause = vi.fn();
  volumeWrites = 0;
  #volume = 1;

  constructor() {
    FakeAudio.instances.push(this);
  }

  get volume(): number {
    return this.#volume;
  }

  set volume(value: number) {
    this.#volume = value;
    this.volumeWrites++;
  }
}

class FakeMediaStream {
  constructor(private readonly tracks: MediaStreamTrack[]) {}

  getAudioTracks(): MediaStreamTrack[] {
    return this.tracks.filter((track) => track.kind === "audio");
  }
}

describe("AudioOutput", () => {
  it("keeps audio attachment effects stable across equivalent renders", () => {
    vi.stubGlobal("Audio", FakeAudio);
    vi.stubGlobal("MediaStream", FakeMediaStream);
    const audioTrack = createFakeMediaStreamTrack({ kind: "audio", id: "remote-audio" });
    const addEndedListener = vi.spyOn(audioTrack, "addEventListener");
    const removeEndedListener = vi.spyOn(audioTrack, "removeEventListener");
    const participants: AudioParticipant[] = [{ id: "remote", audioTrack }];
    const client = createTestClient();
    const view = render(
      <ChalkProvider client={client}>
        <AudioOutput participants={participants} />
      </ChalkProvider>,
    );

    expect(FakeAudio.instances).toHaveLength(1);
    expect(FakeAudio.instances[0]?.play).toHaveBeenCalledTimes(1);
    expect(FakeAudio.instances[0]?.volumeWrites).toBe(1);
    expect(addEndedListener).toHaveBeenCalledTimes(1);

    view.rerender(
      <ChalkProvider client={client}>
        <AudioOutput participants={participants} />
      </ChalkProvider>,
    );

    expect(FakeAudio.instances[0]?.play).toHaveBeenCalledTimes(1);
    expect(FakeAudio.instances[0]?.volumeWrites).toBe(1);
    expect(addEndedListener).toHaveBeenCalledTimes(1);
    expect(removeEndedListener).not.toHaveBeenCalled();
  });
});
