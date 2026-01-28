/**
 * useForegroundService - Android foreground service hook
 * Enables background audio and persistent notification for calls
 */

import { useCallback, useEffect, useState } from "react";
import { NativeModules, Platform } from "react-native";

interface CallServiceModuleType {
	startCallService: (roomId: string, roomName: string) => Promise<void>;
	stopCallService: () => Promise<void>;
	updateNotification: (title: string, body: string) => Promise<void>;
	isServiceRunning: () => Promise<boolean>;
}

const CallServiceModule =
	Platform.OS === "android"
		? (NativeModules.CallServiceModule as CallServiceModuleType | undefined)
		: undefined;

export interface UseForegroundServiceResult {
	/** Whether foreground service is available (Android only) */
	isAvailable: boolean;
	/** Whether the service is currently running */
	isRunning: boolean;
	/** Start the foreground service with room info */
	startService: (roomId: string, roomName: string) => Promise<void>;
	/** Stop the foreground service */
	stopService: () => Promise<void>;
	/** Update the notification content */
	updateNotification: (title: string, body: string) => Promise<void>;
}

export function useForegroundService(): UseForegroundServiceResult {
	const [isRunning, setIsRunning] = useState(false);

	const isAvailable =
		Platform.OS === "android" && CallServiceModule !== undefined;

	useEffect(() => {
		if (!isAvailable || !CallServiceModule) {
			return;
		}

		// Check initial state
		CallServiceModule.isServiceRunning().then(setIsRunning).catch(() => {
			setIsRunning(false);
		});
	}, [isAvailable]);

	const startService = useCallback(
		async (roomId: string, roomName: string) => {
			if (!CallServiceModule) {
				return;
			}

			try {
				await CallServiceModule.startCallService(roomId, roomName);
				setIsRunning(true);
			} catch (err) {
				throw err;
			}
		},
		[],
	);

	const stopService = useCallback(async () => {
		if (!CallServiceModule) {
			return;
		}

		try {
			await CallServiceModule.stopCallService();
			setIsRunning(false);
		} catch (err) {
			throw err;
		}
	}, []);

	const updateNotification = useCallback(async (title: string, body: string) => {
		if (!CallServiceModule) {
			return;
		}

		try {
			await CallServiceModule.updateNotification(title, body);
		} catch (err) {
			throw err;
		}
	}, []);

	return {
		isAvailable,
		isRunning,
		startService,
		stopService,
		updateNotification,
	};
}
