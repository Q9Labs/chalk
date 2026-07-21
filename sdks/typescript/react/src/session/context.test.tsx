// @vitest-environment happy-dom

import type { ChalkSessionSnapshot, ChalkSessionStore } from "@q9labsai/chalk-client";
import { renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { describe, expect, it } from "vitest";

import { ChalkProvider } from "./context";
import { useChalkSession } from "./hooks";

const snapshot: ChalkSessionSnapshot = {
  state: "idle",
  subject: null,
  connection: { sync: "idle", media: "idle" },
  admissionPolicy: null,
  participants: [],
  admissionRequests: [],
  localMedia: {
    microphone: { source: "microphone", state: "unavailable", track: null },
    camera: { source: "camera", state: "unavailable", track: null },
    screen: { source: "screen", state: "unavailable", track: null },
  },
  remoteMedia: [],
  failure: null,
};

function createSession(): ChalkSessionStore {
  const resolved = () => Promise.resolve();
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
  };
}

describe("ChalkProvider", () => {
  it("provides the exact session store instance to descendants", () => {
    const session = createSession();
    const wrapper = ({ children }: PropsWithChildren) => <ChalkProvider session={session}>{children}</ChalkProvider>;
    const { result } = renderHook(() => useChalkSession(), { wrapper });

    expect(result.current).toBe(session);
  });
});
