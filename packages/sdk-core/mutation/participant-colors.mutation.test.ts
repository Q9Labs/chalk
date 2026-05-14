import { describe, expect, it } from "vitest";
import {
  getParticipantAvatarGradient,
  getParticipantAvatarRecipe,
  getParticipantBorder,
  getParticipantGradient,
  getParticipantInitial,
  getParticipantInitials,
  getParticipantThemeVariables,
  PARTICIPANT_GRADIENT_PRESETS,
} from "../src/utils/participant-colors.ts";

describe("getParticipantAvatarRecipe mutation coverage", () => {
  it("builds the web-preferred initials contract", () => {
    expect(getParticipantAvatarRecipe("  John   Doe  ").initials).toBe("JD");
    expect(getParticipantAvatarRecipe("hasan").initials).toBe("H");
    expect(getParticipantAvatarRecipe("Ada Lovelace Byron").initials).toBe("AL");
    expect(getParticipantAvatarRecipe("foo.bar@example.com").initials).toBe("FB");
    expect(getParticipantAvatarRecipe("__").initials).toBe("__");
  });

  it("falls back to a question mark for empty names", () => {
    expect(getParticipantAvatarRecipe("").initials).toBe("?");
    expect(getParticipantAvatarRecipe("   ").initials).toBe("?");
    expect(getParticipantAvatarRecipe("\n\t").initials).toBe("?");
    expect(getParticipantAvatarRecipe(undefined).initials).toBe("?");
  });

  it("derives exact custom gradients, facehash colors, and gradient stops", () => {
    const recipe = getParticipantAvatarRecipe("Hasan", { mode: "custom", from: "#ff00aa", to: "#7c3aed" });

    expect(recipe.avatarGradient).toBe("linear-gradient(135deg, #ff00aa 0%, #7c3aed 100%)");
    expect(recipe.darkerAvatarGradient).toBe("linear-gradient(135deg, #ff00aa 0%, #4c0abd 100%)");
    expect(recipe.colors).toMatchObject({
      id: "custom",
      label: "Custom",
      primary: "#ff00aa",
      gradientEnd: "#7c3aed",
      secondary: "#4c0abd",
      border: "rgba(255, 0, 170, 0.30196078431372547)",
    });
    expect(recipe.facehashColors).toEqual(["#ff00aa", "#7c3aed", "#4c0abd"]);
    expect(recipe.gradientStops).toEqual([
      { color: "#ff00aa", offset: "0%" },
      { color: "#7c3aed", offset: "50%" },
      { color: "#4c0abd", offset: "100%" },
    ]);
  });

  it("falls back to the seeded auto palette when custom colors are invalid", () => {
    const autoRecipe = getParticipantAvatarRecipe("Hasan");

    expect(getParticipantAvatarRecipe("Hasan", { mode: "custom", from: "#ff00aa", to: "7c3aed" })).toEqual(autoRecipe);
    expect(getParticipantAvatarRecipe("Hasan", { mode: "custom", from: "#ff00aa", to: "#7c3ae" })).toEqual(autoRecipe);
    expect(getParticipantAvatarRecipe("Hasan", { mode: "custom", from: "#ff00aa00", to: "#7c3aed" })).toEqual(autoRecipe);
    expect(getParticipantAvatarRecipe("Hasan", { mode: "custom", from: "foo#ff00aa", to: "#7c3aed" })).toEqual(autoRecipe);
    expect(getParticipantAvatarRecipe("Hasan", { mode: "custom", from: "#ff00aa", to: "#7c3aed00" })).toEqual(autoRecipe);
    expect(getParticipantAvatarRecipe("Hasan", { mode: "auto", from: "#ff00aa", to: "#7c3aed" })).toEqual(autoRecipe);
  });

  it("stays deterministic for the same participant seed", () => {
    expect(getParticipantAvatarRecipe("Hasan")).toEqual(getParticipantAvatarRecipe("Hasan"));
  });

  it("changes recipe output when the participant seed changes", () => {
    expect(getParticipantAvatarRecipe("Hasan")).not.toEqual(getParticipantAvatarRecipe("Yahya"));
  });

  it("pins exact seeded palettes for representative participants and fallback guests", () => {
    expect(
      ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"].map((name) => ({
        name,
        id: getParticipantAvatarRecipe(name).colors.id,
        primary: getParticipantAvatarRecipe(name).colors.primary,
      })),
    ).toEqual([
      { name: "A", id: "blue", primary: "#3b82f6" },
      { name: "B", id: "indigo", primary: "#6366f1" },
      { name: "C", id: "violet", primary: "#8b5cf6" },
      { name: "D", id: "mint", primary: "#2dd4bf" },
      { name: "E", id: "green", primary: "#22c55e" },
      { name: "F", id: "rose", primary: "#f43f5e" },
      { name: "G", id: "orange", primary: "#f97316" },
      { name: "H", id: "amber", primary: "#f59e0b" },
      { name: "I", id: "fuchsia", primary: "#d946ef" },
      { name: "J", id: "slate", primary: "#64748b" },
    ]);
    expect(getParticipantAvatarRecipe("Hasan")).toMatchObject({
      avatarGradient: "linear-gradient(135deg, #f97316 0%, #ea580c 100%)",
      darkerAvatarGradient: "linear-gradient(135deg, #f97316 0%, #2a1209 100%)",
      initials: "H",
      colors: {
        id: "orange",
        label: "Orange",
        primary: "#f97316",
        gradientEnd: "#ea580c",
        secondary: "#2a1209",
        border: "rgba(249, 115, 22, 0.3)",
      },
    });
    expect(getParticipantAvatarRecipe("Yahya")).toMatchObject({
      avatarGradient: "linear-gradient(135deg, #d946ef 0%, #c026d3 100%)",
      darkerAvatarGradient: "linear-gradient(135deg, #d946ef 0%, #240a29 100%)",
      initials: "Y",
      colors: {
        id: "fuchsia",
        label: "Fuchsia",
        primary: "#d946ef",
        gradientEnd: "#c026d3",
        secondary: "#240a29",
        border: "rgba(217, 70, 239, 0.3)",
      },
    });
    expect(getParticipantAvatarRecipe(undefined)).toMatchObject({
      avatarGradient: "linear-gradient(135deg, #1bb6a6 0%, #0d9488 100%)",
      darkerAvatarGradient: "linear-gradient(135deg, #1bb6a6 0%, #0a1f1c 100%)",
      initials: "?",
      colors: {
        id: "brand-teal",
        label: "Brand Teal",
        primary: "#1bb6a6",
        gradientEnd: "#0d9488",
        secondary: "#0a1f1c",
        border: "rgba(27, 182, 166, 0.3)",
      },
    });
  });

  it("keeps exported presets and helper utilities aligned with the recipe contract", () => {
    expect(PARTICIPANT_GRADIENT_PRESETS).toHaveLength(15);
    expect(PARTICIPANT_GRADIENT_PRESETS.slice(0, 3)).toEqual([
      { id: "brand-teal", label: "Brand Teal", from: "#1bb6a6", to: "#0d9488", border: "rgba(27, 182, 166, 0.3)" },
      { id: "deep-teal", label: "Deep Teal", from: "#0d9488", to: "#115e59", border: "rgba(13, 148, 136, 0.3)" },
      { id: "cyan", label: "Cyan", from: "#06b6d4", to: "#0891b2", border: "rgba(6, 182, 212, 0.3)" },
    ]);
    expect(getParticipantThemeVariables("Hasan")).toEqual({
      "--primary": "#f97316",
      "--primary-foreground": "#f8fafc",
      "--ring": "#f97316",
    });
    expect(getParticipantThemeVariables("light", { mode: "custom", from: "#ffffff", to: "#ffffff" })).toEqual({
      "--primary": "#ffffff",
      "--primary-foreground": "#0f172a",
      "--ring": "#ffffff",
    });
    expect(getParticipantThemeVariables("dark", { mode: "custom", from: "#000000", to: "#000000" })).toEqual({
      "--primary": "#000000",
      "--primary-foreground": "#f8fafc",
      "--ring": "#000000",
    });
    expect(getParticipantAvatarGradient("Hasan")).toBe("linear-gradient(135deg, #f97316 0%, #ea580c 100%)");
    expect(getParticipantGradient("Hasan")).toBe("linear-gradient(180deg, #f97316 0%, #ea580c 100%)");
    expect(getParticipantBorder("Hasan")).toBe("rgba(249, 115, 22, 0.3)");
    expect(getParticipantInitial(" hasan ")).toBe("H");
    expect(getParticipantInitial(undefined)).toBe("C");
    expect(getParticipantInitials("foo.bar@example.com")).toBe("FB");
    expect(getParticipantInitials(undefined)).toBe("?");
  });
});
