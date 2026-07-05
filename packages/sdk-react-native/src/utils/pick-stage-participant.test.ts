import { describe, expect, it } from "vitest";
import type { ParticipantState } from "../internal/core";
import { pickStageParticipant } from "./pick-stage-participant";

type RoomParticipant = ParticipantState["participants"][number];

function participant(overrides: Partial<RoomParticipant>): RoomParticipant {
  return {
    id: overrides.id ?? "participant-1",
    displayName: overrides.displayName ?? "Participant",
    audioEnabled: overrides.audioEnabled ?? true,
    videoEnabled: overrides.videoEnabled ?? false,
    role: overrides.role ?? "participant",
    joinedAt: overrides.joinedAt ?? new Date(),
    metadata: overrides.metadata ?? {},
    reaction: overrides.reaction ?? null,
    isHandRaised: overrides.isHandRaised ?? false,
    audioTrack: overrides.audioTrack ?? null,
    videoTrack: overrides.videoTrack ?? null,
    screenShareTrack: overrides.screenShareTrack ?? null,
  } as RoomParticipant;
}

describe("pickStageParticipant", () => {
  it("prefers the active screen sharer when present", () => {
    const sharer = participant({ id: "sharer" });
    const local = participant({ id: "local" });

    expect(pickStageParticipant("sharer", [sharer], local, null)?.id).toBe("sharer");
  });

  it("falls back to the local participant when the sharer is not remote", () => {
    const local = participant({ id: "local" });

    expect(pickStageParticipant("missing", [], local, null)?.id).toBe("local");
  });

  it("prefers the active speaker when nobody is sharing", () => {
    const remote = participant({ id: "remote" });
    const activeSpeaker = participant({ id: "speaker" });

    expect(pickStageParticipant(null, [remote], null, activeSpeaker)?.id).toBe("speaker");
  });

  it("falls back to the first remote participant with video", () => {
    const audioOnly = participant({ id: "audio-only" });
    const withVideo = participant({ id: "video", videoTrack: {} as MediaStreamTrack });

    expect(pickStageParticipant(null, [audioOnly, withVideo], null, null)?.id).toBe("video");
  });

  it("falls back to the first remote participant, then local participant", () => {
    const remote = participant({ id: "remote" });
    const local = participant({ id: "local" });

    expect(pickStageParticipant(null, [remote], local, null)?.id).toBe("remote");
    expect(pickStageParticipant(null, [], local, null)?.id).toBe("local");
  });
});
