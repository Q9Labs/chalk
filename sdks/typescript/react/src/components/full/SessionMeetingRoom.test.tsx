// @vitest-environment happy-dom

import type { ChalkSessionSnapshot, ChalkSessionStore } from "@q9labsai/chalk-client";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChalkProvider } from "../../session";
import { SessionMeetingRoom } from "./SessionMeetingRoom";

const audioRendererSpy = vi.hoisted(() => vi.fn((_props: unknown) => null));
const videoGridSpy = vi.hoisted(() => vi.fn((_props: unknown) => null));

vi.mock("../atomic", async (importOriginal) => ({ ...(await importOriginal<typeof import("../atomic")>()), AudioRenderer: audioRendererSpy }));
vi.mock("../composite", async (importOriginal) => ({ ...(await importOriginal<typeof import("../composite")>()), VideoGrid: videoGridSpy }));

beforeEach(() => {
  audioRendererSpy.mockClear();
  videoGridSpy.mockClear();
});

describe("SessionMeetingRoom", () => {
  it("connects the restored meeting controls to Chalk session actions", () => {
    const join = vi.fn(() => Promise.resolve());
    const setMicrophoneEnabled = vi.fn(() => Promise.resolve());
    const store = createStore({ join, setMicrophoneEnabled });
    render(
      <ChalkProvider session={store}>
        <SessionMeetingRoom roomName="Design review" displayName="Ada" />
      </ChalkProvider>,
    );

    expect(screen.getByRole("heading", { name: "Design review" })).toBeInTheDocument();
    expect(screen.getByLabelText("Meeting stage")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Mute microphone" }));
    fireEvent.click(screen.getByRole("button", { name: "People" }));
    fireEvent.click(screen.getByRole("button", { name: "Leave" }));

    expect(join).toHaveBeenCalledOnce();
    expect(setMicrophoneEnabled).toHaveBeenCalledWith(false);
    expect(screen.getByRole("dialog", { name: "Leave Meeting?" })).toBeInTheDocument();
  });

  it("routes remote microphone and screen-share audio to the audio renderer", () => {
    const microphoneTrack = { kind: "audio" } as MediaStreamTrack;
    const screenTrack = { kind: "audio" } as MediaStreamTrack;
    const store = createStore(
      {},
      {
        remoteMedia: [
          { participantSessionId: "remote", source: "microphone", publicationId: "mic", track: microphoneTrack },
          { participantSessionId: "remote", source: "screen", publicationId: "screen-audio", track: screenTrack },
        ],
      },
    );

    render(
      <ChalkProvider session={store}>
        <SessionMeetingRoom roomName="Design review" displayName="Ada" />
      </ChalkProvider>,
    );

    expect(audioRendererSpy.mock.calls.at(-1)?.[0]).toEqual({ participants: [{ id: "remote", audioTrack: microphoneTrack, screenShareAudioTrack: screenTrack }] });
  });

  it("marks a camera-off screen share as renderable video", () => {
    const screenTrack = { kind: "video" } as MediaStreamTrack;
    const store = createStore(
      {},
      {
        participants: [
          { participantSessionId: "local", displayName: "Ada", handRaised: false, role: "host", eligibleRoles: ["host"], capabilities: [] },
          { participantSessionId: "remote", displayName: "Grace", handRaised: false, role: "participant", eligibleRoles: ["participant"], capabilities: [] },
        ],
        remoteMedia: [{ participantSessionId: "remote", source: "screen", publicationId: "screen", track: screenTrack }],
      },
    );

    render(
      <ChalkProvider session={store}>
        <SessionMeetingRoom roomName="Design review" displayName="Ada" />
      </ChalkProvider>,
    );

    const videoGridProps = videoGridSpy.mock.calls.at(-1)?.[0] as { readonly layout: string; readonly participants: readonly unknown[] };
    expect(videoGridProps.layout).toBe("screen-share");
    expect(videoGridProps.participants).toEqual(expect.arrayContaining([expect.objectContaining({ id: "remote", isVideoEnabled: true, isScreenSharing: true, screenShareTrack: screenTrack })]));
  });
});

function createStore(actions: Partial<ChalkSessionStore>, snapshotOverrides: Partial<ChalkSessionSnapshot> = {}): ChalkSessionStore {
  const resolved = () => Promise.resolve();
  const snapshot: ChalkSessionSnapshot = {
    state: "live",
    subject: { tenantId: "tenant", roomId: "room", sessionId: "session", participantSessionId: "local", participantGeneration: 1 },
    connection: { sync: "healthy", media: "healthy" },
    admissionPolicy: "open",
    participants: [{ participantSessionId: "local", displayName: "Ada", handRaised: false, role: "host", eligibleRoles: ["host"], capabilities: [] }],
    admissionRequests: [],
    localMedia: {
      microphone: { source: "microphone", state: "enabled", track: null },
      camera: { source: "camera", state: "disabled", track: null },
      screen: { source: "screen", state: "disabled", track: null },
    },
    remoteMedia: [],
    failure: null,
    ...snapshotOverrides,
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    join: resolved,
    leave: resolved,
    setMicrophoneEnabled: resolved,
    setCameraEnabled: resolved,
    startScreenShare: resolved,
    stopScreenShare: resolved,
    setHandRaised: resolved,
    setDisplayName: resolved,
    setAdmissionPolicy: resolved,
    setParticipantRole: resolved,
    transferHost: resolved,
    admitParticipant: resolved,
    denyAdmission: resolved,
    muteParticipant: resolved,
    stopParticipantCamera: resolved,
    stopParticipantScreenShare: resolved,
    removeParticipant: resolved,
    endSession: resolved,
    ...actions,
  };
}
