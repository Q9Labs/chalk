// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { getStoredMeetingRoomSettings, useMeetingRoomSettings } from "../../hooks/useMeetingRoomSettings";

describe("useMeetingRoomSettings", () => {
  const createStorageMock = () => {
    const values = new Map<string, string>();

    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
      clear: () => {
        values.clear();
      },
      key: (index: number) => Array.from(values.keys())[index] ?? null,
      get length() {
        return values.size;
      },
    };
  };

  beforeEach(() => {
    const local = createStorageMock();
    const session = createStorageMock();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: local,
      writable: true,
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: local,
      writable: true,
    });
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      value: session,
      writable: true,
    });
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: session,
      writable: true,
    });
  });

  it("hydrates defaults and persists updates", () => {
    const { result } = renderHook(() =>
      useMeetingRoomSettings({
        defaults: {
          appearance: {
            layout: "sidebar",
            theme: "dark",
          },
          experience: {
            showInviteToast: false,
          },
        },
      }),
    );

    expect(result.current.settings.appearance.layout).toBe("sidebar");
    expect(result.current.settings.appearance.theme).toBe("dark");
    expect(result.current.settings.appearance.generatedAvatars).toBe(true);
    expect(result.current.settings.experience.showInviteToast).toBe(false);
    expect(result.current.settings.experience.autoOpenPictureInPicture).toBe(true);
    expect(result.current.settings.identity.displayName).toBe("");
    expect(result.current.settings.join.audioEnabled).toBe(false);
    expect(result.current.settings.join.videoEnabled).toBe(false);
    expect(result.current.settings.video.backgroundEffect).toEqual({
      type: "none",
    });

    act(() => {
      result.current.updateAudioSettings({
        selectedInput: "mic-2",
        outputVolume: 72,
      });
    });

    const stored = JSON.parse(localStorage.getItem("chalk-meeting-settings") ?? "{}");

    expect(stored.audio.selectedInput).toBe("mic-2");
    expect(stored.audio.outputVolume).toBe(72);
    expect(stored.video.backgroundEffect).toEqual({ type: "none" });
    expect(stored.version).toBe(7);
  });

  it("migrates existing stored settings with defaults", () => {
    localStorage.setItem(
      "chalk-meeting-settings",
      JSON.stringify({
        version: 2,
        audio: {
          selectedOutput: "speaker-9",
          outputVolume: 55,
        },
        appearance: {
          showFilmstrip: false,
        },
        experience: {
          autoOpenPictureInPicture: false,
        },
      }),
    );

    const { result } = renderHook(() =>
      useMeetingRoomSettings({
        defaults: {
          appearance: {
            layout: "spotlight",
          },
        },
      }),
    );

    expect(result.current.settings.audio.selectedOutput).toBe("speaker-9");
    expect(result.current.settings.audio.outputVolume).toBe(55);
    expect(result.current.settings.appearance.showFilmstrip).toBe(false);
    expect(result.current.settings.appearance.layout).toBe("spotlight");
    expect(result.current.settings.appearance.generatedAvatars).toBe(true);
    expect(result.current.settings.experience.autoOpenPictureInPicture).toBe(false);
    expect(result.current.settings.video.backgroundEffect).toEqual({
      type: "none",
    });
  });

  it("drops malformed stored settings and falls back to defaults", () => {
    localStorage.setItem(
      "chalk-meeting-settings",
      JSON.stringify({
        version: 3,
        audio: "bad-shape",
        appearance: {
          layout: "broken-layout",
        },
        experience: null,
      }),
    );

    const { result } = renderHook(() =>
      useMeetingRoomSettings({
        defaults: {
          appearance: {
            layout: "grid",
            theme: "system",
          },
        },
      }),
    );

    expect(result.current.settings.audio.outputVolume).toBe(100);
    expect(result.current.settings.audio.selectedInput).toBeUndefined();
    expect(result.current.settings.appearance.layout).toBe("grid");
    expect(result.current.settings.experience.showInviteToast).toBe(true);
    expect(result.current.settings.video.backgroundEffect).toEqual({
      type: "none",
    });
  });

  it("persists auto-open picture-in-picture preference", () => {
    const { result } = renderHook(() => useMeetingRoomSettings());

    act(() => {
      result.current.updateExperienceSettings({
        autoOpenPictureInPicture: false,
      });
    });

    const stored = JSON.parse(localStorage.getItem("chalk-meeting-settings") ?? "{}");

    expect(stored.experience.autoOpenPictureInPicture).toBe(false);
    expect(result.current.settings.experience.autoOpenPictureInPicture).toBe(false);
  });

  it("migrates legacy web entry defaults into the SDK settings store", () => {
    localStorage.setItem("chalk_default_name", "Hasan");
    localStorage.setItem("chalk_join_muted", "true");
    localStorage.setItem("chalk_join_no_video", "true");
    sessionStorage.setItem("chalk_display_name", "Ignored Session Name");

    const { result } = renderHook(() => useMeetingRoomSettings());

    expect(result.current.settings.identity.displayName).toBe("Hasan");
    expect(result.current.settings.join.audioEnabled).toBe(false);
    expect(result.current.settings.join.videoEnabled).toBe(false);

    act(() => {
      result.current.updateJoinSettings({
        audioEnabled: true,
      });
    });

    expect(localStorage.getItem("chalk_default_name")).toBeNull();
    expect(localStorage.getItem("chalk_join_muted")).toBeNull();
    expect(localStorage.getItem("chalk_join_no_video")).toBeNull();
    expect(getStoredMeetingRoomSettings().identity.displayName).toBe("Hasan");
    expect(getStoredMeetingRoomSettings().join.audioEnabled).toBe(true);
  });

  it("falls back to no background effect for malformed stored background data", () => {
    localStorage.setItem(
      "chalk-meeting-settings",
      JSON.stringify({
        version: 3,
        video: {
          backgroundEffect: {
            type: "custom",
            assetKey: 123,
          },
        },
      }),
    );

    const { result } = renderHook(() => useMeetingRoomSettings());

    expect(result.current.settings.video.backgroundEffect).toEqual({
      type: "none",
    });
  });

  it("persists selected background effects", () => {
    const { result } = renderHook(() => useMeetingRoomSettings());

    act(() => {
      result.current.updateVideoSettings({
        backgroundEffect: {
          type: "preset",
          presetId: "preset-study",
        },
      });
    });

    const stored = JSON.parse(localStorage.getItem("chalk-meeting-settings") ?? "{}");

    expect(stored.video.backgroundEffect).toEqual({
      type: "preset",
      presetId: "preset-study",
    });
  });

  it("persists a custom profile gradient override", () => {
    const { result } = renderHook(() => useMeetingRoomSettings());

    act(() => {
      result.current.updateAppearanceSettings({
        profileGradient: {
          mode: "custom",
          from: "#112233",
          to: "#445566",
        },
      });
    });

    const stored = JSON.parse(localStorage.getItem("chalk-meeting-settings") ?? "{}");

    expect(stored.version).toBe(7);
    expect(stored.appearance.profileGradient).toEqual({
      mode: "custom",
      from: "#112233",
      to: "#445566",
    });
    expect(result.current.settings.appearance.profileGradient).toEqual({
      mode: "custom",
      from: "#112233",
      to: "#445566",
    });
  });

  it("persists the generated avatar preference", () => {
    const { result } = renderHook(() => useMeetingRoomSettings());

    act(() => {
      result.current.updateAppearanceSettings({
        generatedAvatars: false,
      });
    });

    const stored = JSON.parse(localStorage.getItem("chalk-meeting-settings") ?? "{}");

    expect(stored.version).toBe(7);
    expect(stored.appearance.generatedAvatars).toBe(false);
    expect(result.current.settings.appearance.generatedAvatars).toBe(false);
  });
});
