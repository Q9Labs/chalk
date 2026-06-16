// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { act } from "react";
import type { ComponentProps } from "react";

import { SettingsDialog } from "../../components/composite/SettingsDialog";
import { PARTICIPANT_GRADIENT_PRESETS } from "../../utils/colorGenerator";

const settings = {
  version: 7,
  identity: {
    displayName: "Hasan",
  },
  join: {
    audioEnabled: true,
    videoEnabled: true,
  },
  audio: {
    selectedInput: undefined,
    selectedOutput: undefined,
    outputVolume: 100,
    noiseSuppression: true,
  },
  video: {
    selectedInput: undefined,
    backgroundEffect: { type: "none" as const },
  },
  appearance: {
    theme: "system" as const,
    gradient: "default" as const,
    generatedAvatars: true,
    profileGradient: {
      mode: "auto" as const,
    },
    layout: "grid" as const,
    showFilmstrip: true,
    reducedMotion: false,
    ambientBackground: true,
  },
  experience: {
    showInviteToast: true,
    defaultOpenChat: false,
    defaultOpenParticipants: false,
    defaultOpenTranscription: false,
    autoOpenPictureInPicture: true,
  },
};

function renderDialog(overrides: Partial<ComponentProps<typeof SettingsDialog>> = {}) {
  return render(<SettingsDialog isOpen onClose={() => {}} settings={settings} onUpdateIdentity={() => {}} onUpdateJoin={() => {}} onUpdateAudio={() => {}} onUpdateVideo={() => {}} onUpdateAppearance={() => {}} onUpdateExperience={() => {}} {...overrides} />);
}

function clickSection(getAllByRole: ReturnType<typeof renderDialog>["getAllByRole"], label: string) {
  const button = getAllByRole("button").find((candidate) => candidate.textContent?.includes(label));
  expect(button).toBeDefined();
  fireEvent.click(button!);
}

describe("SettingsDialog", () => {
  afterEach(() => {
    globalThis.navigator.mediaDevices ??= {} as MediaDevices;
    globalThis.navigator.mediaDevices.enumerateDevices = async () => [];
  });

  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query) => ({
      matches: query.includes("min-width: 768px") || query.includes("min-width: 1024px"),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });

  it("falls back to browser-enumerated media devices", async () => {
    globalThis.navigator.mediaDevices ??= {} as MediaDevices;
    globalThis.navigator.mediaDevices.enumerateDevices = vi.fn().mockResolvedValue([
      {
        deviceId: "mic-fallback",
        kind: "audioinput",
        label: "Fallback Mic",
        groupId: "group-1",
        toJSON: () => ({}),
      },
      {
        deviceId: "cam-fallback",
        kind: "videoinput",
        label: "Fallback Cam",
        groupId: "group-2",
        toJSON: () => ({}),
      },
    ]);

    const { getAllByRole, getByRole, findByText } = renderDialog();

    await waitFor(() => {
      expect(globalThis.navigator.mediaDevices.enumerateDevices).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      fireEvent.click(getAllByRole("button", { name: "Select device" })[0]);
    });
    expect(await findByText("Fallback Mic")).toBeDefined();

    act(() => {
      clickSection(getAllByRole, "Video");
    });
    expect(getByRole("heading", { name: "Camera" })).toBeDefined();
  }, 10_000);

  it("keeps a fixed dialog shell height across sections on desktop", () => {
    const { getByRole } = renderDialog();

    expect(getByRole("dialog", { name: "Meeting settings" }).className).toMatch(/md:h-\[min\(720px/);
    expect(getByRole("dialog", { name: "Meeting settings" }).className).not.toContain("max-h-");
  });

  it("propagates the Chalk theme onto the portaled dialog shell", () => {
    document.documentElement.setAttribute("data-chalk-theme", "dark");

    try {
      const { getByRole } = renderDialog();
      expect(getByRole("dialog", { name: "Meeting settings" }).getAttribute("data-chalk-theme")).toBe("dark");
    } finally {
      document.documentElement.removeAttribute("data-chalk-theme");
    }
  });

  it("renders background effects when enabled and supported", () => {
    const onSelectBackgroundEffect = vi.fn();
    const { getAllByRole, getByRole } = renderDialog({
      enableBackgroundEffects: true,
      isBackgroundEffectsSupported: true,
      backgroundEffects: [
        {
          id: "blur",
          type: "blur",
          name: "Blur",
        },
      ],
      selectedBackgroundEffectId: "none",
      onSelectBackgroundEffect,
    });

    act(() => {
      clickSection(getAllByRole, "Video");
    });
    fireEvent.click(getByRole("button", { name: "Select Blur" }));

    expect(getByRole("group", { name: "Background effects" })).toBeDefined();
    expect(onSelectBackgroundEffect).toHaveBeenCalledWith("blur");
  });

  it("shows unsupported background effects note", () => {
    const { getAllByRole, getByText } = renderDialog({
      enableBackgroundEffects: true,
    });

    act(() => {
      clickSection(getAllByRole, "Video");
    });
    expect(getByText("Background effects are not supported in this browser yet.")).toBeDefined();
  });

  it("renders picture-in-picture experience controls and manual open action", () => {
    const onUpdateExperience = vi.fn();
    const onOpenPictureInPicture = vi.fn();
    const { getAllByRole, getByRole } = renderDialog({
      onUpdateExperience,
      enablePictureInPicture: true,
      isPictureInPictureSupported: true,
      onOpenPictureInPicture,
    });

    act(() => {
      clickSection(getAllByRole, "Experience");
    });

    fireEvent.click(getByRole("switch", { name: "Auto-open Picture-in-Picture" }));
    expect(onUpdateExperience).toHaveBeenCalledWith({
      autoOpenPictureInPicture: false,
    });

    fireEvent.click(getByRole("button", { name: "Open Picture-in-Picture now" }));
    expect(onOpenPictureInPicture).toHaveBeenCalledTimes(1);
  });

  it("lets users pin a preset profile gradient from the swatch picker", () => {
    const onUpdateAppearance = vi.fn();
    const preset = PARTICIPANT_GRADIENT_PRESETS[2];
    const { getAllByRole, getByRole, queryByLabelText } = renderDialog({
      onUpdateAppearance,
      participantColorSeed: "Hasan Shoaib",
    });

    act(() => {
      clickSection(getAllByRole, "Appearance");
    });

    expect(queryByLabelText("Gradient start color")).toBeNull();
    fireEvent.click(getByRole("button", { name: `Use ${preset.label} profile gradient` }));
    expect(onUpdateAppearance).toHaveBeenCalledWith({
      profileGradient: {
        mode: "custom",
        from: preset.from,
        to: preset.to,
      },
    });
  });

  it("makes the auto profile gradient option explicit", () => {
    const { getAllByRole, getAllByLabelText, getAllByText } = renderDialog({
      participantColorSeed: "Hasan Shoaib",
    });

    act(() => {
      clickSection(getAllByRole, "Appearance");
    });

    expect(getAllByLabelText("Use automatic profile gradient")[0]).toBeDefined();
    expect(getAllByText("Automatic Identity")[0]).toBeDefined();
  });

  it("lets users switch fun avatars off", () => {
    const onUpdateAppearance = vi.fn();
    const { getAllByRole, getByRole } = renderDialog({
      onUpdateAppearance,
    });

    act(() => {
      clickSection(getAllByRole, "Appearance");
    });

    fireEvent.click(getByRole("switch", { name: "Fun avatars" }));
    expect(onUpdateAppearance).toHaveBeenCalledWith({
      generatedAvatars: false,
    });
  });

  it("stores identity and join defaults from the experience section", () => {
    const onUpdateIdentity = vi.fn();
    const onUpdateJoin = vi.fn();
    const { getAllByRole, getByRole } = renderDialog({
      onUpdateIdentity,
      onUpdateJoin,
    });

    act(() => {
      clickSection(getAllByRole, "Experience");
    });

    fireEvent.change(getAllByRole("textbox")[1]!, {
      target: { value: "Hasan Shoaib" },
    });
    expect(onUpdateIdentity).toHaveBeenCalledWith({
      displayName: "Hasan Shoaib",
    });

    fireEvent.click(getByRole("switch", { name: "Join muted" }));
    expect(onUpdateJoin).toHaveBeenCalledWith({
      audioEnabled: false,
    });
  });
});
