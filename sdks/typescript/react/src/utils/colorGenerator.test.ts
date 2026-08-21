import { describe, expect, it } from "vitest";

import { getParticipantAvatarRecipe, getParticipantColor } from "./colorGenerator";

describe("participant avatar colors", () => {
  it("uses the Participant primary color for generated and initial avatars", () => {
    const participantColor = getParticipantColor("Nora Williams");
    const avatarRecipe = getParticipantAvatarRecipe("Nora Williams");

    expect(avatarRecipe.color).toBe(participantColor.primary);
    expect(avatarRecipe.facehashColors).toEqual([participantColor.primary]);
  });
});
