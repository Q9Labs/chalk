import type { UseMeetingParticipantsReturn } from "../../hooks/useMeetingParticipants";
import type { NativeActionCommands } from "../../room-actions/native-room-actions";
import { describe, expect, it, vi } from "vitest";

vi.mock("react", () => ({
  useEffect: () => undefined,
  useRef: <T>(current: T) => ({ current }),
}));
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));

import { useConferenceViewParticipants } from "./useConferenceViewParticipants";

describe("useConferenceViewParticipants", () => {
  it("projects participant controls and routes moderation commands", async () => {
    const session = {
      admitParticipant: vi.fn(async () => undefined),
      denyAdmission: vi.fn(async () => undefined),
      assignRole: vi.fn(async () => undefined),
      assignOwner: vi.fn(async () => undefined),
      removeParticipant: vi.fn(async () => undefined),
      muteParticipant: vi.fn(async () => undefined),
      requestUnmute: vi.fn(async () => undefined),
      requestStartCamera: vi.fn(async () => undefined),
      stopParticipantCamera: vi.fn(async () => undefined),
      stopParticipantScreenShare: vi.fn(async () => undefined),
    };
    const participants: UseMeetingParticipantsReturn = {
      participants: [],
      localParticipant: null,
      remoteParticipants: [],
      activeSpeaker: null,
      count: 1,
      participantCount: 1,
      getParticipant: () => undefined,
      updateDisplayName: vi.fn(async () => undefined),
    };
    const commands: NativeActionCommands = {
      sendChatMessage: vi.fn(async () => undefined),
      sendReaction: vi.fn(async () => undefined),
      requestUnmute: vi.fn(async () => undefined),
      requestStartCamera: vi.fn(async () => undefined),
      muteParticipant: vi.fn(async () => undefined),
      stopParticipantCamera: vi.fn(async () => undefined),
      removeParticipant: vi.fn(async () => undefined),
      acceptMediaRequest: vi.fn(async () => undefined),
      declineMediaRequest: vi.fn(),
    };
    const run = vi.fn(async (action: () => unknown | Promise<unknown>) => {
      await action();
    });
    const result = useConferenceViewParticipants({
      isHost: true,
      snapshot: { incomingMediaRequests: [], admissionRequests: [] },
      session,
      participants,
      commands,
      run,
    });

    result.admitParticipant("request-1");
    result.removeParticipant("participant-1");
    await Promise.resolve();

    expect(result).toMatchObject({ isHost: true, selfName: "Guest", participantCount: 1, admissionRequests: [] });
    expect(session.admitParticipant).toHaveBeenCalledWith("request-1");
    expect(session.removeParticipant).toHaveBeenCalledWith("participant-1");
    expect(run).toHaveBeenCalledTimes(2);
  });
});
