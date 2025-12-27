/**
 * useDevices hook - List and select media devices
 */

import type { MediaDevice } from "@chalk/core";
import { useCallback, useEffect, useState } from "react";
import { useChalk } from "../context.tsx";

export interface UseDevicesResult {
	/** All available media devices */
	devices: MediaDevice[];
	/** Available camera devices */
	cameras: MediaDevice[];
	/** Available microphone devices */
	microphones: MediaDevice[];
	/** Available speaker devices */
	speakers: MediaDevice[];
	/** Currently selected camera device ID */
	selectedCamera: string | null;
	/** Currently selected microphone device ID */
	selectedMicrophone: string | null;
	/** Switch to a different camera */
	selectCamera: (deviceId: string) => Promise<boolean>;
	/** Switch to a different microphone */
	selectMicrophone: (deviceId: string) => Promise<boolean>;
	/** Refresh the device list */
	refreshDevices: () => Promise<void>;
	/** Whether devices are currently loading */
	isLoading: boolean;
}

/**
 * Hook for managing media devices (cameras, microphones, speakers)
 *
 * @example
 * ```tsx
 * function DeviceSelector() {
 *   const { cameras, selectedCamera, selectCamera } = useDevices();
 *
 *   return (
 *     <select
 *       value={selectedCamera ?? ''}
 *       onChange={(e) => selectCamera(e.target.value)}
 *     >
 *       {cameras.map((camera) => (
 *         <option key={camera.deviceId} value={camera.deviceId}>
 *           {camera.label}
 *         </option>
 *       ))}
 *     </select>
 *   );
 * }
 * ```
 */
export function useDevices(): UseDevicesResult {
	const { room } = useChalk();
	const [devices, setDevices] = useState<MediaDevice[]>([]);
	const [selectedCamera, setSelectedCamera] = useState<string | null>(null);
	const [selectedMicrophone, setSelectedMicrophone] = useState<string | null>(
		null,
	);
	const [isLoading, setIsLoading] = useState(false);

	// Derived device lists
	const cameras = devices.filter((d) => d.kind === "videoinput");
	const microphones = devices.filter((d) => d.kind === "audioinput");
	const speakers = devices.filter((d) => d.kind === "audiooutput");

	const refreshDevices = useCallback(async () => {
		if (!room) return;

		setIsLoading(true);
		try {
			const deviceList = await room.getDevices();
			setDevices(deviceList);
		} finally {
			setIsLoading(false);
		}
	}, [room]);

	// Load devices when room is available
	useEffect(() => {
		if (room) {
			refreshDevices();
		}
	}, [room, refreshDevices]);

	// Listen for device changes (e.g., USB camera plugged in)
	useEffect(() => {
		const handleDeviceChange = () => {
			refreshDevices();
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
	}, [refreshDevices]);

	const selectCamera = useCallback(
		async (deviceId: string): Promise<boolean> => {
			if (!room) return false;

			const success = await room.selectCamera(deviceId);
			if (success) {
				setSelectedCamera(deviceId);
			}
			return success;
		},
		[room],
	);

	const selectMicrophone = useCallback(
		async (deviceId: string): Promise<boolean> => {
			if (!room) return false;

			const success = await room.selectMicrophone(deviceId);
			if (success) {
				setSelectedMicrophone(deviceId);
			}
			return success;
		},
		[room],
	);

	return {
		devices,
		cameras,
		microphones,
		speakers,
		selectedCamera,
		selectedMicrophone,
		selectCamera,
		selectMicrophone,
		refreshDevices,
		isLoading,
	};
}
