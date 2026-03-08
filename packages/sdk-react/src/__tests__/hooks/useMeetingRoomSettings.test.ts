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
		expect(stored.version).toBe(2);
	});

	it("merges existing stored settings with defaults", () => {
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
	});

	it("drops malformed stored settings and falls back to defaults", () => {
		localStorage.setItem(
			"chalk-meeting-settings",
			JSON.stringify({
				version: 2,
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
	});
});
