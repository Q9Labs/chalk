import { useCallback, useMemo, useState } from "react";

import type { MeetingLayout } from "../components/full/meeting-room/types";

export interface MeetingRoomSettings {
	version: number;
	audio: {
		selectedInput?: string;
		selectedOutput?: string;
		outputVolume: number;
		noiseSuppression: boolean;
	};
	video: {
		selectedInput?: string;
	};
	appearance: {
		theme: "light" | "dark" | "system";
		layout: MeetingLayout;
		showFilmstrip: boolean;
		reducedMotion: boolean;
	};
	experience: {
		showInviteToast: boolean;
		defaultOpenChat: boolean;
		defaultOpenParticipants: boolean;
		defaultOpenTranscription: boolean;
	};
}

interface UseMeetingRoomSettingsOptions {
	defaults?: Partial<Omit<MeetingRoomSettings, "version">>;
}

const SETTINGS_KEY = "chalk-meeting-settings";
const SETTINGS_VERSION = 2;

const createDefaultSettings = (
	defaults?: UseMeetingRoomSettingsOptions["defaults"],
): MeetingRoomSettings => ({
	version: SETTINGS_VERSION,
	audio: {
		outputVolume: 100,
		noiseSuppression: true,
		...defaults?.audio,
	},
	video: {
		...defaults?.video,
	},
	appearance: {
		theme: "system",
		layout: "grid",
		showFilmstrip: true,
		reducedMotion: false,
		...defaults?.appearance,
	},
	experience: {
		showInviteToast: true,
		defaultOpenChat: false,
		defaultOpenParticipants: false,
		defaultOpenTranscription: false,
		...defaults?.experience,
	},
});

const mergeSettings = (
	base: MeetingRoomSettings,
	stored: Partial<MeetingRoomSettings> | null,
): MeetingRoomSettings => {
	if (!stored || stored.version !== SETTINGS_VERSION) {
		return base;
	}

	return {
		...base,
		...stored,
		audio: { ...base.audio, ...stored.audio },
		video: { ...base.video, ...stored.video },
		appearance: { ...base.appearance, ...stored.appearance },
		experience: { ...base.experience, ...stored.experience },
	};
};

export function useMeetingRoomSettings({
	defaults,
}: UseMeetingRoomSettingsOptions = {}) {
	const baseSettings = useMemo(() => createDefaultSettings(defaults), [defaults]);

	const [settings, setSettings] = useState<MeetingRoomSettings>(() => {
		if (typeof window === "undefined") {
			return baseSettings;
		}

		try {
			const stored = localStorage.getItem(SETTINGS_KEY);
			if (!stored) {
				return baseSettings;
			}

			return mergeSettings(
				baseSettings,
				JSON.parse(stored) as Partial<MeetingRoomSettings>,
			);
		} catch {
			return baseSettings;
		}
	});

	const persist = useCallback((next: MeetingRoomSettings) => {
		if (typeof window === "undefined") {
			return;
		}

		try {
			localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
		} catch {
			// Ignore storage failures; keep the in-memory settings usable.
		}
	}, []);

	const updateSettings = useCallback(
		(
			updater:
				| Partial<MeetingRoomSettings>
				| ((previous: MeetingRoomSettings) => MeetingRoomSettings),
		) => {
			setSettings((previous) => {
				const next =
					typeof updater === "function"
						? updater(previous)
						: {
								...previous,
								...updater,
							};

				persist(next);
				return next;
			});
		},
		[persist],
	);

	const updateAudioSettings = useCallback(
		(updates: Partial<MeetingRoomSettings["audio"]>) => {
			updateSettings((previous) => ({
				...previous,
				audio: { ...previous.audio, ...updates },
			}));
		},
		[updateSettings],
	);

	const updateVideoSettings = useCallback(
		(updates: Partial<MeetingRoomSettings["video"]>) => {
			updateSettings((previous) => ({
				...previous,
				video: { ...previous.video, ...updates },
			}));
		},
		[updateSettings],
	);

	const updateAppearanceSettings = useCallback(
		(updates: Partial<MeetingRoomSettings["appearance"]>) => {
			updateSettings((previous) => ({
				...previous,
				appearance: { ...previous.appearance, ...updates },
			}));
		},
		[updateSettings],
	);

	const updateExperienceSettings = useCallback(
		(updates: Partial<MeetingRoomSettings["experience"]>) => {
			updateSettings((previous) => ({
				...previous,
				experience: { ...previous.experience, ...updates },
			}));
		},
		[updateSettings],
	);

	return {
		settings,
		updateSettings,
		updateAudioSettings,
		updateVideoSettings,
		updateAppearanceSettings,
		updateExperienceSettings,
	};
}
