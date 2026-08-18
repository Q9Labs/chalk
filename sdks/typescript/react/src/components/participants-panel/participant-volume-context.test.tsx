// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChalkProvider } from "../../bindings/context";
import { AudioOutput } from "../audio-output/AudioOutput";
import { ParticipantsPanel } from "./ParticipantsPanel";
import { ParticipantVolumeProvider, useParticipantVolumeContext } from "./participant-volume-context";
import { createSnapshot, createTestClient } from "../../test-support/test-client";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

class FakeAudio {
  static instances: FakeAudio[] = [];
  volume = 1;
  autoplay = false;
  muted = false;
  srcObject: MediaStream | null = null;
  play = vi.fn(async () => undefined);
  pause = vi.fn();
  addEventListener = vi.fn();
  removeEventListener = vi.fn();

  constructor() {
    FakeAudio.instances.push(this);
  }
}

class FakeMediaStream {
  constructor(private readonly tracks: MediaStreamTrack[]) {}

  getAudioTracks(): MediaStreamTrack[] {
    return this.tracks.filter((track) => track.kind === "audio");
  }
}

function createParticipantsClient() {
  const client = createTestClient();
  const snapshot = client.getSnapshot();
  client.setSnapshot({
    ...snapshot,
    self: { ...snapshot.self, participantId: "local", displayName: "You" },
    participants: {
      ...snapshot.participants,
      roster: [
        { participantId: "local", displayName: "You", role: "member", eligibleRoles: [], capabilities: [], handRaised: false, presence: { state: "connected", speaking: false, activeSpeaker: false }, media: { microphone: "active", camera: "inactive", screenShare: "inactive" } },
        { participantId: "remote", displayName: "Remote", role: "member", eligibleRoles: [], capabilities: [], handRaised: false, presence: { state: "connected", speaking: false, activeSpeaker: false }, media: { microphone: "active", camera: "inactive", screenShare: "inactive" } },
      ],
    },
  });
  return client;
}

function VolumeSetter(): React.JSX.Element {
  const state = useParticipantVolumeContext();
  return (
    <button type="button" onClick={() => state?.setVolume("remote", 25)}>
      Set remote volume
    </button>
  );
}

describe("participant volume contracts", () => {
  it("propagates provider volume changes to AudioOutput", () => {
    vi.stubGlobal("Audio", FakeAudio);
    vi.stubGlobal("MediaStream", FakeMediaStream);
    const track = { id: "remote-audio", kind: "audio", readyState: "live", addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as MediaStreamTrack;
    const client = createTestClient({
      ...createSnapshot(),
      media: { ...createSnapshot().media, remote: [{ participantId: "remote", source: "microphone", publicationId: "publication-1", track }] },
    });

    render(
      <ChalkProvider client={client}>
        <ParticipantVolumeProvider>
          <VolumeSetter />
          <AudioOutput />
        </ParticipantVolumeProvider>
      </ChalkProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Set remote volume" }));

    expect(FakeAudio.instances[0]?.volume).toBe(0.25);
  });

  it("keeps local participant volume state in a bare ParticipantsPanel", () => {
    const client = createParticipantsClient();
    render(
      <ChalkProvider client={client}>
        <ParticipantsPanel variant="sidebar" />
      </ChalkProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Options for Remote" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Mute volume" }));

    expect(screen.getByText("0%")).toBeInTheDocument();
  });

  it("uses the controlled participant volume callback", () => {
    const client = createParticipantsClient();
    const onParticipantVolumeChange = vi.fn();
    render(
      <ChalkProvider client={client}>
        <ParticipantsPanel variant="sidebar" participantVolumes={new Map([["remote", 70]])} onParticipantVolumeChange={onParticipantVolumeChange} />
      </ChalkProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Options for Remote" }));
    fireEvent.click(screen.getByRole("button", { name: "Mute volume" }));

    expect(onParticipantVolumeChange).toHaveBeenCalledWith("remote", 0);
  });
});
