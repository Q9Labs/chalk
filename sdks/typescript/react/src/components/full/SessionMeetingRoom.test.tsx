// @vitest-environment happy-dom

import type { ChalkSessionSnapshot, ChalkSessionStore } from "@q9labsai/chalk-client";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ChalkProvider } from "../../session";
import { SessionMeetingRoom } from "./SessionMeetingRoom";

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
});

function createStore(actions: Partial<ChalkSessionStore>): ChalkSessionStore {
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
