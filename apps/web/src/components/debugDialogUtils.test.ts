import { describe, expect, it } from "vitest";

import {
  getParticipantSeed,
  getParticipantThemeVariables,
  resolveParticipantId,
} from "./debugDialogUtils";

describe("debugDialogUtils", () => {
  it("prefers display name when deriving the participant color seed", () => {
    expect(
      getParticipantSeed({
        displayName: "Host",
        participantId: "participant-123",
        routeRoomId: "meeting-abc",
      }),
    ).toBe("Host");
  });

  it("falls back to the SDK client participant id when hook state is missing", () => {
    expect(
      resolveParticipantId(undefined, null, "participant-123"),
    ).toBe("participant-123");
  });

  it("returns stable theme variables for the same participant seed", () => {
    expect(getParticipantThemeVariables("Host")).toEqual(
      getParticipantThemeVariables("Host"),
    );
  });
});
