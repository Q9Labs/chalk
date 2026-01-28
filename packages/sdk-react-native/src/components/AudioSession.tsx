/**
 * AudioSession component - Manages iOS/Android audio routing and focus
 * Handles speakerphone, Bluetooth, and audio focus management
 */

import React, { useCallback, useEffect, useState } from "react";
import {
	DeviceEventEmitter,
	NativeEventEmitter,
	NativeModules,
	Platform,
} from "react-native";

interface AudioSessionModuleType {
	configureForCall: () => Promise<void>;
	setOutputRoute: (route: string) => Promise<void>;
	getAvailableRoutes: () => Promise<string[]>;
	getCurrentRoute: () => Promise<string>;
	setSpeakerphone: (enabled: boolean) => Promise<void>;
}

const AudioSessionModule = NativeModules.AudioSessionModule as
	| AudioSessionModuleType
	| undefined;

interface AudioSessionProps {
	/** Whether audio should be routed to speaker (loud speaker) */
	useSpeaker?: boolean;
	children?: React.ReactNode;
}

/**
 * AudioSession configures audio routing for the entire call
 * On iOS: Controls AVAudioSession category
 * On Android: Manages audio focus
 *
 * @example
 * ```tsx
 * function CallScreen() {
 *   return (
 *     <AudioSession useSpeaker={true}>
 *       <VideoGrid />
 *       <Controls />
 *     </AudioSession>
 *   );
 * }
 * ```
 */
export function AudioSession({
	useSpeaker = false,
	children,
}: AudioSessionProps) {
	useEffect(() => {
		configureAudioSession(useSpeaker);
	}, [useSpeaker]);

	return <>{children}</>;
}

async function configureAudioSession(useSpeaker: boolean): Promise<void> {
	if (!AudioSessionModule) {
		return;
	}

	try {
		await AudioSessionModule.configureForCall();
		await AudioSessionModule.setSpeakerphone(useSpeaker);
	} catch {
		// Silently ignore error
	}
}

/**
 * Hook to toggle speakerphone mode
 * Use this in your call screen components
 */
export function useSpeakerphone() {
	const [isSpeakerOn, setIsSpeakerOn] = useState(false);

	const toggle = useCallback(async () => {
		const newState = !isSpeakerOn;

		if (!AudioSessionModule) {
			setIsSpeakerOn(newState);
			return;
		}

		try {
			await AudioSessionModule.setSpeakerphone(newState);
			setIsSpeakerOn(newState);
		} catch {
			// Silently ignore error
		}
	}, [isSpeakerOn]);

	const setSpeaker = useCallback(async (enabled: boolean) => {
		if (!AudioSessionModule) {
			setIsSpeakerOn(enabled);
			return;
		}

		try {
			await AudioSessionModule.setSpeakerphone(enabled);
			setIsSpeakerOn(enabled);
		} catch {
			// Silently ignore error
		}
	}, []);

	return { isSpeakerOn, toggle, setSpeaker };
}

/**
 * Hook to check if Bluetooth audio is available and manage Bluetooth routing
 */
export function useBluetoothAudio() {
	const [isBluetoothAvailable, setIsBluetoothAvailable] = useState(false);
	const [isBluetoothConnected, setIsBluetoothConnected] = useState(false);

	useEffect(() => {
		if (!AudioSessionModule) {
			return;
		}

		// Check initial state
		checkBluetoothStatus();

		// Subscribe to route change events
		const eventEmitter =
			Platform.OS === "ios"
				? new NativeEventEmitter(NativeModules.AudioSessionModule)
				: DeviceEventEmitter;

		const subscription = eventEmitter.addListener(
			"onRouteChange",
			(event: { route: string; availableRoutes?: string[] }) => {
				setIsBluetoothConnected(event.route === "bluetooth");
				if (event.availableRoutes) {
					setIsBluetoothAvailable(event.availableRoutes.includes("bluetooth"));
				}
			},
		);

		return () => subscription.remove();
	}, []);

	async function checkBluetoothStatus() {
		if (!AudioSessionModule) {
			return;
		}

		try {
			const routes = await AudioSessionModule.getAvailableRoutes();
			const currentRoute = await AudioSessionModule.getCurrentRoute();

			setIsBluetoothAvailable(routes.includes("bluetooth"));
			setIsBluetoothConnected(currentRoute === "bluetooth");
		} catch {
			// Silently ignore error
		}
	}

	const connectBluetooth = useCallback(async () => {
		if (!AudioSessionModule) {
			return;
		}

		try {
			await AudioSessionModule.setOutputRoute("bluetooth");
			setIsBluetoothConnected(true);
		} catch {
			// Silently ignore error
		}
	}, []);

	const disconnectBluetooth = useCallback(async () => {
		if (!AudioSessionModule) {
			return;
		}

		try {
			await AudioSessionModule.setOutputRoute("speaker");
			setIsBluetoothConnected(false);
		} catch {
			// Silently ignore error
		}
	}, []);

	return {
		isBluetoothAvailable,
		isBluetoothConnected,
		connectBluetooth,
		disconnectBluetooth,
	};
}
