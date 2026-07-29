// @vitest-environment happy-dom

import type { ChalkSessionSnapshot, ChalkSessionStore, ChalkWhiteboardV1Transport } from "@q9labsai/chalk-client";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChalkProvider } from "../../session";
import { SessionMeetingRoom } from "./SessionMeetingRoom";

const audioRendererSpy = vi.hoisted(() => vi.fn((_props: unknown) => null));
const videoGridSpy = vi.hoisted(() => vi.fn((_props: unknown) => null));
const whiteboardPanelSpy = vi.hoisted(() => vi.fn((_props: unknown) => <div data-testid="whiteboard-panel" />));

vi.mock("../atomic", async (importOriginal) => ({ ...(await importOriginal<typeof import("../atomic")>()), AudioRenderer: audioRendererSpy }));
vi.mock("../composite", async (importOriginal) => ({ ...(await importOriginal<typeof import("../composite")>()), VideoGrid: videoGridSpy }));
vi.mock("./WhiteboardPanel", () => ({ WhiteboardPanel: whiteboardPanelSpy }));

beforeEach(() => {
  audioRendererSpy.mockClear();
  videoGridSpy.mockClear();
  whiteboardPanelSpy.mockClear();
});

afterEach(cleanup);

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
    fireEvent.click(screen.getAllByRole("button", { name: "People" })[0]!);
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

  it("exposes negotiated chat and reactions and delegates their actions", async () => {
    const sendChatMessage = vi.fn(() => Promise.resolve());
    const sendReaction = vi.fn(() => Promise.resolve());
    const markChatRead = vi.fn();
    const store = createStore(
      { sendChatMessage, sendReaction, markChatRead },
      {
        roomActions: { phase: "healthy", capabilities: ["sendChat", "sendReaction"], error: null },
      },
    );

    render(
      <ChalkProvider session={store}>
        <SessionMeetingRoom roomName="Design review" displayName="Ada" />
      </ChalkProvider>,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Chat" })[0]!);
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "  Hello team  " } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(sendChatMessage).toHaveBeenCalledWith({ text: "Hello team" }));
    expect(markChatRead).toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole("button", { name: "Reactions" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "React with 👍" }));
    await waitFor(() => expect(sendReaction).toHaveBeenCalledWith("👍"));
  });

  it("exposes durable chat pagination and failed-message retry", async () => {
    const loadOlderChatMessages = vi.fn(() => Promise.resolve());
    const retryChatMessage = vi.fn(() => Promise.resolve());
    const store = createStore(
      { loadOlderChatMessages, retryChatMessage },
      {
        roomActions: { phase: "healthy", capabilities: ["sendChat"], error: null },
        chat: {
          status: "ready",
          messages: [],
          pending: [
            {
              clientMessageId: "client-1",
              text: "Please retry",
              state: "failed",
              error: {
                code: "command_rejected",
                action: "sendChatMessage",
                recoverable: true,
                message: "Message was not acknowledged",
              },
            },
          ],
          hasOlder: true,
          historyTruncated: false,
          retainedFloorSequence: null,
          unreadCount: 0,
          error: null,
        },
      },
    );

    render(
      <ChalkProvider session={store}>
        <SessionMeetingRoom roomName="Design review" displayName="Ada" />
      </ChalkProvider>,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Chat" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Load earlier messages" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(loadOlderChatMessages).toHaveBeenCalledOnce());
    await waitFor(() => expect(retryChatMessage).toHaveBeenCalledWith("client-1"));
  });

  it("hides chat and reactions when room-actions negotiation does not grant them", () => {
    const store = createStore({}, { roomActions: { phase: "disabled", capabilities: [], error: null } });

    render(
      <ChalkProvider session={store}>
        <SessionMeetingRoom roomName="Design review" displayName="Ada" />
      </ChalkProvider>,
    );

    expect(screen.queryAllByRole("button", { name: "Chat" })).toHaveLength(0);
    expect(screen.queryAllByRole("button", { name: "Reactions" })).toHaveLength(0);
  });

  it("routes directed media requests without exposing force-unmute", async () => {
    const requestUnmute = vi.fn(() => Promise.resolve());
    const requestStartCamera = vi.fn(() => Promise.resolve());
    const store = createStore(
      { requestUnmute, requestStartCamera },
      {
        participants: [
          { participantSessionId: "local", displayName: "Ada", handRaised: false, role: "host", eligibleRoles: ["host"], capabilities: ["requestMediaOthers"] },
          { participantSessionId: "remote", displayName: "Grace", handRaised: false, role: "participant", eligibleRoles: ["participant"], capabilities: [] },
        ],
      },
    );

    render(
      <ChalkProvider session={store}>
        <SessionMeetingRoom roomName="Design review" displayName="Ada" />
      </ChalkProvider>,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "People" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Options for Grace" }));
    expect(screen.queryByRole("button", { name: "Unmute" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ask to unmute" }));
    await waitFor(() => expect(requestUnmute).toHaveBeenCalledWith("remote"));

    fireEvent.click(screen.getByRole("button", { name: "Options for Grace" }));
    fireEvent.click(screen.getByRole("button", { name: "Ask to start camera" }));
    await waitFor(() => expect(requestStartCamera).toHaveBeenCalledWith("remote"));
  });

  it("lets a participant accept or decline an incoming media request", async () => {
    const acceptMediaRequest = vi.fn(() => Promise.resolve());
    const declineMediaRequest = vi.fn();
    const store = createStore(
      { acceptMediaRequest, declineMediaRequest },
      {
        incomingMediaRequests: [
          {
            requestId: "request-1",
            kind: "unmute",
            actorParticipantSessionId: "host",
            actorDisplayName: "Grace",
            expiresAt: "2026-07-29T20:00:00.000Z",
          },
        ],
      },
    );

    render(
      <ChalkProvider session={store}>
        <SessionMeetingRoom roomName="Design review" displayName="Ada" />
      </ChalkProvider>,
    );

    expect(screen.getByRole("dialog", { name: "Unmute request" })).toHaveTextContent("Grace is asking you to unmute");
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(acceptMediaRequest).toHaveBeenCalledWith("request-1"));
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(declineMediaRequest).toHaveBeenCalledWith("request-1");
  });

  it("starts and stops the separate whiteboard-v1 transport with the board", async () => {
    const startSceneSubscription = vi.fn(() => Promise.resolve());
    const stopSceneSubscription = vi.fn();
    const whiteboard = createWhiteboard({ startSceneSubscription, stopSceneSubscription });
    const store = createStore(
      { whiteboard },
      {
        whiteboard: {
          status: "ready",
          sceneId: "scene-1",
          revision: "1",
          capabilities: ["drawWhiteboard"],
          canDraw: true,
          canClear: false,
          error: null,
        },
      },
    );
    const { unmount } = render(
      <ChalkProvider session={store}>
        <SessionMeetingRoom roomName="Design review" displayName="Ada" />
      </ChalkProvider>,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Whiteboard" })[0]!);
    await waitFor(() => expect(startSceneSubscription).toHaveBeenCalledOnce());
    expect(screen.getByTestId("whiteboard-panel")).toBeInTheDocument();
    expect(whiteboardPanelSpy.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({ canDraw: true, collab: expect.objectContaining({ subscribe: expect.any(Function), submitUpdate: expect.any(Function) }) }));

    unmount();
    expect(stopSceneSubscription).toHaveBeenCalledOnce();
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
    roomActions: { phase: "disabled", capabilities: [], error: null },
    participantRoomActionCapabilities: {},
    participantMedia: {},
    reactions: [],
    chat: {
      status: "idle",
      messages: [],
      pending: [],
      hasOlder: false,
      historyTruncated: false,
      retainedFloorSequence: null,
      unreadCount: 0,
      error: null,
    },
    whiteboard: {
      status: "unsubscribed",
      sceneId: null,
      revision: null,
      capabilities: [],
      canDraw: false,
      canClear: false,
      error: null,
    },
    incomingMediaRequests: [],
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
    sendReaction: resolved,
    sendChatMessage: resolved,
    retryChatMessage: resolved,
    loadOlderChatMessages: resolved,
    markChatRead: () => undefined,
    requestUnmute: resolved,
    requestStartCamera: resolved,
    acceptMediaRequest: resolved,
    declineMediaRequest: () => undefined,
    whiteboard: null,
    ...actions,
  };
}

function createWhiteboard(overrides: Partial<ChalkWhiteboardV1Transport> = {}): ChalkWhiteboardV1Transport {
  const resolved = () => Promise.resolve();
  return {
    startSceneSubscription: resolved,
    stopSceneSubscription: () => undefined,
    subscribe: () => () => undefined,
    submitUpdate: resolved,
    sendCursor: () => undefined,
    requestSnapshot: resolved,
    clear: resolved,
    setDrawPermission: resolved,
    files: {
      initiateUpload: resolved,
      finalizeUpload: resolved,
      getDownloadUrl: resolved,
    },
    ...overrides,
  } as ChalkWhiteboardV1Transport;
}
