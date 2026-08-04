import { describe, expect, it } from "vitest";
import { getParticipantAvatarRecipe, getParticipantColor, getParticipantInitials, PARTICIPANT_AVATAR_PALETTE } from "./participant-avatar";

describe("participant identity colors", () => {
  it("chooses one approved flat identity color deterministically", () => {
    const first = getParticipantColor("Avery Chen");
    const second = getParticipantColor("Avery Chen");

    expect(first).toEqual(second);
    expect(PARTICIPANT_AVATAR_PALETTE.map(({ primary }) => primary)).toContain(first.primary);
    expect(first.gradientEnd).toBe(first.primary);
  });

  it("keeps avatar recipes flat for compatibility consumers", () => {
    const recipe = getParticipantAvatarRecipe("Avery Chen");

    expect(recipe.gradientStops).toEqual([
      { color: recipe.colors.primary, offset: "0%" },
      { color: recipe.colors.primary, offset: "100%" },
    ]);
    expect(recipe.facehashColors).toEqual([recipe.colors.primary, recipe.colors.primary, recipe.colors.primary]);
  });

  it("returns one or two initials without making identity noun assumptions", () => {
    expect(getParticipantInitials("Avery Chen")).toBe("AC");
    expect(getParticipantInitials("Avery")).toBe("A");
    expect(getParticipantInitials()).toBe("?");
  });
});
