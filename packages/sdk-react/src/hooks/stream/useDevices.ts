"use client";

/**
 * useDevices - Device management from MediaManager
 *
 * Focused hook for device selection and enumeration.
 */

import type { MediaDevice, MediaState } from "@q9labs/chalk-core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "../../context/chalk-provider";

export interface UseDevicesReturn {
	/** All available devices */
	devices: readonly MediaDevice[];
	/** Available cameras */
	cameras: readonly MediaDevice[];
	/** Available microphones */
	microphones: readonly MediaDevice[];
	/** Available speakers */
	speakers: readonly MediaDevice[];
	/** Selected camera device ID */
	selectedCamera: string | null;
	/** Selected microphone device ID */
	selectedMicrophone: string | null;
	/** Selected speaker device ID */
	selectedSpeaker: string | null;
	/** Whether devices are loading */
	isLoading: boolean;
	/** Select a camera */
	selectCamera: (deviceId: string) => Promise<void>;
	/** Select a microphone */
	selectMicrophone: (deviceId: string) => Promise<void>;
	/** Select a speaker */
	selectSpeaker: (deviceId: string) => Promise<void>;
	/** Refresh device list */
	refreshDevices: () => Promise<readonly MediaDevice[]>;
	/** Undo last device change (within 5s) */
	undoDeviceChange: () => void;
}

/**
 * Hook for device management
 *
 * @example
 * ```tsx
 * function DeviceSelector() {
 *   const { cameras, selectedCamera, selectCamera } = useDevices();
 *
 *   return (
 *     <select
 *       value={selectedCamera ?? ''}
 *       onChange={e => selectCamera(e.target.value)}
 *     >
 *       {cameras.map(cam => (
 *         <option key={cam.deviceId} value={cam.deviceId}>
 *           {cam.label}
 *         </option>
 *       ))}
 *     </select>
 *   );
 * }
 * ```
 */
export function useDevices(): UseDevicesReturn {
	const session = useSession();
	const { media } = session;

	const [state, setState] = useState<MediaState>(() => media.getState());
	const [isLoading, setIsLoading] = useState(false);

	useEffect(() => {
		return media.subscribe(setState);
	}, [media]);

	// Listen for device changes from browser
	useEffect(() => {
		const handleDeviceChange = (): void => {
			media.refreshDevices();
		};

		navigator.mediaDevices?.addEventListener(
			"devicechange",
			handleDeviceChange,
		);

		return () => {
			navigator.mediaDevices?.removeEventListener(
				"devicechange",
				handleDeviceChange,
			);
		};
	}, [media]);

	const selectCamera = useCallback(
		(deviceId: string): Promise<void> => media.selectCamera(deviceId),
		[media],
	);

	const selectMicrophone = useCallback(
		(deviceId: string): Promise<void> => media.selectMicrophone(deviceId),
		[media],
	);

	const selectSpeaker = useCallback(
		(deviceId: string): Promise<void> => media.selectSpeaker(deviceId),
		[media],
	);

	const refreshDevices = useCallback(async (): Promise<
		readonly MediaDevice[]
	> => {
		setIsLoading(true);
		try {
			return await media.refreshDevices();
		} finally {
			setIsLoading(false);
		}
	}, [media]);

	const undoDeviceChange = useCallback(
		(): void => media.undoDeviceChange(),
		[media],
	);

	return useMemo(
		(): UseDevicesReturn => ({
			devices: state.devices,
			cameras: media.cameras,
			microphones: media.microphones,
			speakers: media.speakers,
			selectedCamera: state.selectedCamera,
			selectedMicrophone: state.selectedMicrophone,
			selectedSpeaker: state.selectedSpeaker,
			isLoading,
			selectCamera,
			selectMicrophone,
			selectSpeaker,
			refreshDevices,
			undoDeviceChange,
		}),
		[
			state,
			media,
			isLoading,
			selectCamera,
			selectMicrophone,
			selectSpeaker,
			refreshDevices,
			undoDeviceChange,
		],
	);
}
