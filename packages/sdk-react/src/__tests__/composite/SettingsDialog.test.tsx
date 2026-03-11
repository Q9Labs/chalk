import { afterEach, describe, expect, it, vi } from "bun:test";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { act } from "react";

import { SettingsDialog } from "../../components/composite/SettingsDialog";
import { PARTICIPANT_GRADIENT_PRESETS } from "../../utils/colorGenerator";

const settings = {
  version: 5,
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

describe("SettingsDialog", () => {
  afterEach(() => {
    globalThis.navigator.mediaDevices ??= {} as MediaDevices;
    globalThis.navigator.mediaDevices.enumerateDevices = async () => [];
  });

  // Mock matchMedia to simulate desktop by default
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

    const { getAllByRole, getByText, getByRole, findByText } = render(<SettingsDialog isOpen onClose={() => {}} settings={settings} onUpdateAudio={() => {}} onUpdateVideo={() => {}} onUpdateAppearance={() => {}} onUpdateExperience={() => {}} />);

    await waitFor(() => {
      expect(globalThis.navigator.mediaDevices.enumerateDevices).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      fireEvent.click(getAllByRole("button", { name: "Select device" })[0]);
    });
    expect(await findByText("Fallback Mic")).toBeDefined();

    act(() => {
      fireEvent.click(getByText("Video"));
    });
    expect(getByRole("heading", { name: "Camera" })).toBeDefined();
  });

  it("keeps a fixed dialog shell height across sections on desktop", () => {
    const { getByRole } = render(<SettingsDialog isOpen onClose={() => {}} settings={settings} onUpdateAudio={() => {}} onUpdateVideo={() => {}} onUpdateAppearance={() => {}} onUpdateExperience={() => {}} />);

    expect(getByRole("dialog", { name: "Meeting settings" }).className).toMatch(/md:h-\[min\(720px/);
    expect(getByRole("dialog", { name: "Meeting settings" }).className).not.toContain("max-h-");
  });

  it("renders background effects when enabled and supported", () => {
    const onSelectBackgroundEffect = vi.fn();
    const { getByText, getByRole } = render(
      <SettingsDialog
        isOpen
        onClose={() => {}}
        settings={settings}
        onUpdateAudio={() => {}}
        onUpdateVideo={() => {}}
        onUpdateAppearance={() => {}}
        onUpdateExperience={() => {}}
        enableBackgroundEffects
        isBackgroundEffectsSupported
        backgroundEffects={[
          {
            id: "blur",
            type: "blur",
            name: "Blur",
          },
        ]}
        selectedBackgroundEffectId="none"
        onSelectBackgroundEffect={onSelectBackgroundEffect}
      />,
    );

    act(() => {
      fireEvent.click(getByText("Video"));
    });
    fireEvent.click(getByRole("button", { name: "Select Blur" }));

    expect(getByRole("group", { name: "Background effects" })).toBeDefined();
    expect(onSelectBackgroundEffect).toHaveBeenCalledWith("blur");
  });

  it("shows unsupported background effects note", () => {
    const { getByText } = render(<SettingsDialog isOpen onClose={() => {}} settings={settings} onUpdateAudio={() => {}} onUpdateVideo={() => {}} onUpdateAppearance={() => {}} onUpdateExperience={() => {}} enableBackgroundEffects />);

    act(() => {
      fireEvent.click(getByText("Video"));
    });
    expect(getByText("Background effects are not supported in this browser yet.")).toBeDefined();
  });

  it("renders picture-in-picture experience controls and manual open action", () => {
    const onUpdateExperience = vi.fn();
    const onOpenPictureInPicture = vi.fn();
    const { getByRole, getByText } = render(
      <SettingsDialog isOpen onClose={() => {}} settings={settings} onUpdateAudio={() => {}} onUpdateVideo={() => {}} onUpdateAppearance={() => {}} onUpdateExperience={onUpdateExperience} enablePictureInPicture isPictureInPictureSupported onOpenPictureInPicture={onOpenPictureInPicture} />,
    );

    act(() => {
      fireEvent.click(getByText("Experience"));
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
    const { getByText, getByRole, queryByLabelText } = render(
      <SettingsDialog
        isOpen
        onClose={() => {}}
        settings={settings}
        onUpdateAudio={() => {}}
        onUpdateVideo={() => {}}
        onUpdateAppearance={onUpdateAppearance}
        onUpdateExperience={() => {}}
        participantColorSeed="Hasan Shoaib"
      />,
    );

    act(() => {
      fireEvent.click(getByText("Appearance"));
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
    const { getByText, getByLabelText } = render(
      <SettingsDialog
        isOpen
        onClose={() => {}}
        settings={settings}
        onUpdateAudio={() => {}}
        onUpdateVideo={() => {}}
        onUpdateAppearance={() => {}}
        onUpdateExperience={() => {}}
        participantColorSeed="Hasan Shoaib"
      />,
    );

    act(() => {
      fireEvent.click(getByText("Appearance"));
    });

    expect(getByLabelText("Use automatic profile gradient")).toBeDefined();
    expect(getByText("Automatic Identity")).toBeDefined();
  });

});
