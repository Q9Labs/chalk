import { afterEach, describe, expect, it, vi } from "bun:test";
import { fireEvent, render, waitFor } from "@testing-library/react";

import { SettingsDialog } from "../../components/composite/SettingsDialog";

const settings = {
	version: 2,
	audio: {
		selectedInput: undefined,
		selectedOutput: undefined,
		outputVolume: 100,
		noiseSuppression: true,
	},
	video: {
		selectedInput: undefined,
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

		const { getAllByRole, getByText, getByRole, findByText } = render(
			<SettingsDialog
				isOpen
				onClose={() => {}}
				settings={settings}
				onUpdateAudio={() => {}}
				onUpdateVideo={() => {}}
				onUpdateAppearance={() => {}}
				onUpdateExperience={() => {}}
			/>
		);

		await waitFor(() => {
			expect(globalThis.navigator.mediaDevices.enumerateDevices).toHaveBeenCalledTimes(1);
		});

		fireEvent.click(getAllByRole("button", { name: "Select device" })[0]);
		expect(await findByText("Fallback Mic")).toBeDefined();

		fireEvent.click(getByText("Video"));
		fireEvent.click(getByRole("button", { name: "Select device" }));
		expect(await findByText("Fallback Cam")).toBeDefined();
	});
});
