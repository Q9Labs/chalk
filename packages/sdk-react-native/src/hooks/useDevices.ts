/**
 * useDevices hook - List and select media devices (cameras, microphones)
 */

import type { MediaDevice } from "@chalk/core";
import { useCallback, useEffect, useState } from "react";
import { useChalk } from "../ChalkProvider";

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

export function useDevices(): UseDevicesResult {
	const { room, rtcManager } = useChalk();
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
		if (!rtcManager) return;

		setIsLoading(true);
		try {
			const deviceList = await rtcManager.enumerateDevices();

			// Convert RTC device info to Chalk MediaDevice format
			const mediaDevices: MediaDevice[] = deviceList.map((d) => ({
				deviceId: d.deviceId,
				label:
					d.label ||
					`${d.kind} ${deviceList.filter((x) => x.kind === d.kind).indexOf(d)}`,
				kind: d.kind as "videoinput" | "audioinput" | "audiooutput",
			}));

			setDevices(mediaDevices);
		} finally {
			setIsLoading(false);
		}
	}, [rtcManager]);

	// Load devices when manager is available
	useEffect(() => {
		if (rtcManager) {
			refreshDevices();
		}
	}, [rtcManager, refreshDevices]);

	const selectCamera = useCallback(
		async (deviceId: string): Promise<boolean> => {
			if (!room) return false;

			try {
				const success = await room.selectCamera(deviceId);
				if (success) {
					setSelectedCamera(deviceId);
				}
				return success;
			} catch (err) {
				console.error("[useDevices] selectCamera error:", err);
				return false;
			}
		},
		[room],
	);

	const selectMicrophone = useCallback(
		async (deviceId: string): Promise<boolean> => {
			if (!room) return false;

			try {
				const success = await room.selectMicrophone(deviceId);
				if (success) {
					setSelectedMicrophone(deviceId);
				}
				return success;
			} catch (err) {
				console.error("[useDevices] selectMicrophone error:", err);
				return false;
			}
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
