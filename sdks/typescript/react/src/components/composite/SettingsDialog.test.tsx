// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SettingsDialog, type SettingsDialogValue } from "./SettingsDialog";

vi.mock("../../internal/useMediaQuery", () => ({
  useMediaQuery: () => true,
  usePrefersReducedMotion: () => true,
}));

vi.mock("../../utils/theme", () => ({
  resolvePortalThemeFromDocument: () => "light",
}));

afterEach(cleanup);

describe("SettingsDialog appearance", () => {
  it("exposes every palette independently from the selected texture", () => {
    const onUpdateAppearance = vi.fn();
    render(<SettingsDialog isOpen onClose={vi.fn()} settings={createSettings()} onUpdateIdentity={vi.fn()} onUpdateJoin={vi.fn()} onUpdateAudio={vi.fn()} onUpdateVideo={vi.fn()} onUpdateAppearance={onUpdateAppearance} onUpdateExperience={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /Appearance/ }));
    fireEvent.click(screen.getByRole("button", { name: /Warm Porcelain/ }));
    fireEvent.click(screen.getByRole("button", { name: "Use Slate texture" }));

    expect(onUpdateAppearance).toHaveBeenCalledWith({ palette: "warm-porcelain", theme: "light" });
    expect(onUpdateAppearance).toHaveBeenCalledWith({ texture: "slate" });
    expect(document.querySelector("[data-chalk-chrome]")).toBeInTheDocument();
    expect(document.querySelector('[data-chalk-palette="warm-charcoal"]')).toHaveAttribute("data-chalk-theme", "dark");
    expect(document.querySelector('[data-chalk-palette="warm-charcoal"]')).toHaveAttribute("data-chalk-texture", "paper");
  });
});

function createSettings(): SettingsDialogValue {
  return {
    identity: { displayName: "Ada" },
    join: { videoEnabled: true, audioEnabled: true },
    audio: { outputVolume: 80, noiseSuppression: true, echoCancellation: true, autoGainControl: true },
    video: { quality: "auto" },
    appearance: {
      layout: "focus",
      theme: "dark",
      palette: "warm-charcoal",
      texture: "paper",
      gradient: "default",
      showFilmstrip: true,
      reducedMotion: false,
      generatedAvatars: true,
      profileGradient: { mode: "auto" },
      ambientBackground: false,
    },
    experience: {
      captions: false,
      compactMode: false,
      showInviteToast: false,
      defaultOpenChat: false,
      defaultOpenParticipants: false,
      defaultOpenTranscription: false,
      autoOpenPictureInPicture: false,
    },
  };
}
