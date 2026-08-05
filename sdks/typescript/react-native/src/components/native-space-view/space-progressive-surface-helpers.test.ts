import { describe, expect, it } from "vitest";

import { buildParticipantActionDescriptors, formatChatTimestamp } from "./space-progressive-surface-helpers";

describe("space progressive surface helpers", () => {
  it("only exposes capability-backed Participant actions", () => {
    const actions = buildParticipantActionDescriptors({
      canMuteParticipants: true,
      canRequestMedia: false,
      canStopParticipantCamera: false,
      canStopParticipantScreenShare: false,
      canRemoveParticipants: true,
    });

    expect(actions.map((action) => action.label)).toEqual(["Mute microphone", "Remove Participant"]);
    expect(actions.at(-1)?.destructive).toBe(true);
  });

  it("formats valid chat timestamps and ignores empty metadata", () => {
    expect(formatChatTimestamp(0)).toBe("");
    expect(formatChatTimestamp(Number.NaN)).toBe("");
    expect(formatChatTimestamp(Date.UTC(2026, 7, 4, 12, 34))).toMatch(/\d{1,2}:34/);
  });
});
