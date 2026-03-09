import { beforeEach, describe, expect, it } from "bun:test";
import { act, renderHook } from "@testing-library/react";

import { useMeetingRoomSettings } from "../../hooks/useMeetingRoomSettings";

describe("useMeetingRoomSettings", () => {
	beforeEach(() => {
		localStorage.clear();
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
		expect(result.current.settings.experience.showInviteToast).toBe(false);
		expect(result.current.settings.video.backgroundEffect).toEqual({
			type: "none",
		});

		act(() => {
			result.current.updateAudioSettings({
				selectedInput: "mic-2",
				outputVolume: 72,
			});
		});

		const stored = JSON.parse(
			localStorage.getItem("chalk-meeting-settings") ?? "{}",
		);

		expect(stored.audio.selectedInput).toBe("mic-2");
		expect(stored.audio.outputVolume).toBe(72);
		expect(stored.video.backgroundEffect).toEqual({ type: "none" });
		expect(stored.version).toBe(3);
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

		const stored = JSON.parse(
			localStorage.getItem("chalk-meeting-settings") ?? "{}",
		);

		expect(stored.video.backgroundEffect).toEqual({
			type: "preset",
			presetId: "preset-study",
		});
	});
});
