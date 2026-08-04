import { describe, expect, it } from "vitest";

import { buildParticipantActionDescriptors, displayParticipantRole, formatChatTimestamp, nextAssignableRole } from "./space-progressive-surface-helpers";

describe("space progressive surface helpers", () => {
  it("renders wire roles with glossary vocabulary", () => {
    expect(displayParticipantRole("host")).toBe("owner");
    expect(displayParticipantRole("cohost")).toBe("collaborator");
    expect(displayParticipantRole("participant")).toBe("observer");
    expect(nextAssignableRole("cohost")).toBe("participant");
    expect(nextAssignableRole("participant")).toBe("cohost");
    expect(nextAssignableRole("host")).toBeNull();
  });

  it("only exposes capability-backed Participant actions", () => {
    const actions = buildParticipantActionDescriptors("cohost", {
      canMuteParticipants: true,
      canRequestMedia: false,
      canStopParticipantCamera: false,
      canStopParticipantScreenShare: false,
      canSetParticipantRole: true,
      canTransferHost: true,
      canRemoveParticipants: true,
    });

    expect(actions.map((action) => action.label)).toEqual(["Mute microphone", "Make observer", "Make owner", "Remove Participant"]);
    expect(actions.at(-1)?.destructive).toBe(true);
  });

  it("formats valid chat timestamps and ignores empty metadata", () => {
    expect(formatChatTimestamp(0)).toBe("");
    expect(formatChatTimestamp(Number.NaN)).toBe("");
    expect(formatChatTimestamp(Date.UTC(2026, 7, 4, 12, 34))).toMatch(/\d{1,2}:34/);
  });
});
