import { afterEach, describe, expect, it, vi } from "bun:test";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { act } from "react";

import { SettingsDialog } from "../../components/composite/SettingsDialog";

const settings = {
  version: 3,
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
    layout: "grid" as const,
    showFilmstrip: true,
    reducedMotion: false,
  },
  experience: {
    showInviteToast: true,
    defaultOpenChat: false,
    defaultOpenParticipants: false,
    defaultOpenTranscription: false,
  },
};

describe("SettingsDialog", () => {
  afterEach(() => {
    globalThis.navigator.mediaDevices ??= {} as MediaDevices;
    globalThis.navigator.mediaDevices.enumerateDevices = async () => [];
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

  it("keeps a fixed dialog shell height across sections", () => {
    const { getByRole } = render(<SettingsDialog isOpen onClose={() => {}} settings={settings} onUpdateAudio={() => {}} onUpdateVideo={() => {}} onUpdateAppearance={() => {}} onUpdateExperience={() => {}} />);

    expect(getByRole("dialog", { name: "Meeting settings" }).className).toMatch(/\bh-\[min\(720px/);
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
});
