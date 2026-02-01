/**
 * useParticipantVolume - Local-only per-participant volume control
 *
 * Manages a Map<participantId, volume> where volume is 0-100.
 * Default (no entry) = 100%. Setting back to 100 removes the entry.
 * getAudioVolume returns 0-1 for use with HTMLAudioElement.volume.
 */

import { useCallback, useMemo, useState } from "react";

export interface UseParticipantVolumeReturn {
	/** Map of participantId -> volume (0-100). Only contains adjusted participants. */
	participantVolumes: ReadonlyMap<string, number>;
	/** Set volume for a participant (0-100). Setting 100 removes the entry. */
	setParticipantVolume: (id: string, volume: number) => void;
	/** Reset a participant's volume to default (100). */
	resetParticipantVolume: (id: string) => void;
	/** Get normalized volume (0-1) for AudioRenderer. Returns 1 if not set. */
	getAudioVolume: (id: string) => number;
}

export function useParticipantVolume(): UseParticipantVolumeReturn {
	const [volumes, setVolumes] = useState<ReadonlyMap<string, number>>(
		() => new Map(),
	);

	const setParticipantVolume = useCallback((id: string, volume: number) => {
		const clamped = Math.round(Math.min(100, Math.max(0, volume)));

		setVolumes((prev) => {
			const next = new Map(prev);
			if (clamped >= 100) {
				next.delete(id);
			} else {
				next.set(id, clamped);
			}
			return next;
		});
	}, []);

	const resetParticipantVolume = useCallback((id: string) => {
		setVolumes((prev) => {
			const next = new Map(prev);
			next.delete(id);
			return next;
		});
	}, []);

	const getAudioVolume = useCallback(
		(id: string): number => {
			const vol = volumes.get(id);
			return vol === undefined ? 1 : vol / 100;
		},
		[volumes],
	);

	return useMemo(
		() => ({
			participantVolumes: volumes,
			setParticipantVolume,
			resetParticipantVolume,
			getAudioVolume,
		}),
		[volumes, setParticipantVolume, resetParticipantVolume, getAudioVolume],
	);
}
