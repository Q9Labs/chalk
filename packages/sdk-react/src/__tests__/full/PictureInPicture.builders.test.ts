import { describe, expect, it } from "bun:test";

import { buildMeetingPictureInPictureSource, buildPreJoinPictureInPictureSource } from "../../components/full/picture-in-picture";

function createTrack() {
  return {
    readyState: "live",
  } as MediaStreamTrack;
}

function createParticipant(overrides: Record<string, unknown> = {}) {
  return {
    id: "participant",
    displayName: "Participant",
    isLocal: false,
    isSpeaking: false,
    isMuted: false,
    isVideoEnabled: false,
    isScreenSharing: false,
    isHandRaised: false,
    avatarUrl: undefined,
    videoTrack: null,
    screenShareTrack: null,
    role: "participant" as const,
    ...overrides,
  };
}

describe("picture-in-picture builders", () => {
  it("keeps prejoin PiP focused on the local participant", () => {
    const source = buildPreJoinPictureInPictureSource({
      displayName: "Hasan",
      videoTrack: createTrack(),
      isAudioEnabled: true,
      isVideoEnabled: true,
    });

    expect(source.id).toBe("prejoin-local");
    expect(source.videoTrack).not.toBeNull();
    expect(source.isLocal).toBe(true);
  });

  it("promotes an audio-only active speaker instead of falling back to the local user", () => {
    const localParticipant = createParticipant({
      id: "local",
      displayName: "Hasan",
      isLocal: true,
      videoTrack: createTrack(),
      isVideoEnabled: true,
    });
    const activeSpeaker = createParticipant({
      id: "teacher",
      displayName: "Teacher",
      isSpeaking: true,
      isVideoEnabled: false,
    });

    const result = buildMeetingPictureInPictureSource({
      participants: [localParticipant, activeSpeaker] as any,
      localParticipant: localParticipant as any,
    });

    expect(result.meetingLayout).toBe("split");
    expect(result.source?.id).toBe("teacher");
    expect(result.participantSources?.map((participant) => participant.id)).toEqual(["teacher", "local"]);
  });

  it("deprioritizes the local participant when nobody has video", () => {
    const localParticipant = createParticipant({
      id: "local",
      displayName: "Hasan",
      isLocal: true,
    });
    const remoteParticipant = createParticipant({
      id: "student",
      displayName: "Student",
    });

    const result = buildMeetingPictureInPictureSource({
      participants: [localParticipant, remoteParticipant] as any,
      localParticipant: localParticipant as any,
    });

    expect(result.source?.id).toBe("student");
    expect(result.participantSources?.[0]?.id).toBe("student");
  });

  it("switches to a 2x2 grid with an overflow tile for larger meetings", () => {
    const localParticipant = createParticipant({
      id: "local",
      displayName: "Hasan",
      isLocal: true,
    });
    const participants = [
      localParticipant,
      createParticipant({ id: "a", displayName: "A", isSpeaking: true }),
      createParticipant({ id: "b", displayName: "B" }),
      createParticipant({ id: "c", displayName: "C" }),
      createParticipant({ id: "d", displayName: "D" }),
    ];

    const result = buildMeetingPictureInPictureSource({
      participants: participants as any,
      localParticipant: localParticipant as any,
    });

    expect(result.meetingLayout).toBe("grid");
    expect(result.participantSources).toHaveLength(4);
    expect(result.participantSources?.[3]).toMatchObject({
      kind: "placeholder",
      title: "+2",
      subtitle: "more",
    });
  });

  it("keeps screen share dominant and adds a side rail of participants", () => {
    const localParticipant = createParticipant({
      id: "local",
      displayName: "Hasan",
      isLocal: true,
    });
    const screenSharer = createParticipant({
      id: "teacher",
      displayName: "Teacher",
      isScreenSharing: true,
      screenShareTrack: createTrack(),
    });
    const speaker = createParticipant({
      id: "student",
      displayName: "Student",
      isSpeaking: true,
    });

    const result = buildMeetingPictureInPictureSource({
      participants: [localParticipant, screenSharer, speaker] as any,
      localParticipant: localParticipant as any,
    });

    expect(result.meetingLayout).toBe("screen-share");
    expect(result.source).toMatchObject({
      id: "screen-share:teacher",
      kind: "screen-share",
    });
    expect(result.participantSources?.map((participant) => participant.id)).toEqual(["student", "local"]);
  });

  it("prioritizes the whiteboard when it is open", () => {
    const localParticipant = createParticipant({
      id: "local",
      displayName: "Hasan",
      isLocal: true,
    });
    const remoteParticipant = createParticipant({
      id: "student",
      displayName: "Student",
      isSpeaking: true,
    });

    const result = buildMeetingPictureInPictureSource({
      participants: [localParticipant, remoteParticipant] as any,
      localParticipant: localParticipant as any,
      isWhiteboardOpen: true,
      whiteboardSnapshot: {
        elements: [],
        appState: {},
        files: {},
        key: "whiteboard:1",
      },
    });

    expect(result.meetingLayout).toBe("screen-share");
    expect(result.source).toMatchObject({
      id: "whiteboard",
      kind: "whiteboard",
      title: "Whiteboard",
    });
    expect(result.participantSources?.map((participant) => participant.id)).toEqual(["student", "local"]);
  });

  it("keeps the local participant's own screen share inline in PiP", () => {
    const localParticipant = createParticipant({
      id: "local",
      displayName: "Hasan",
      isLocal: true,
      isScreenSharing: true,
      screenShareTrack: createTrack(),
      isVideoEnabled: true,
      videoTrack: createTrack(),
    });
    const remoteParticipant = createParticipant({
      id: "student",
      displayName: "Student",
      isSpeaking: true,
    });

    const result = buildMeetingPictureInPictureSource({
      participants: [localParticipant, remoteParticipant] as any,
      localParticipant: localParticipant as any,
    });

    expect(result.meetingLayout).toBe("screen-share");
    expect(result.source?.kind).toBe("screen-share");
    expect(result.source?.id).toBe("screen-share:local");
    expect(result.participantSources?.map((participant) => participant.id)).toEqual(["student"]);
  });
});
