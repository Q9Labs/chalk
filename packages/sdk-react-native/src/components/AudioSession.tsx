/**
 * AudioSession component - Manages iOS/Android audio routing and focus
 * Handles speakerphone, Bluetooth, and audio focus management
 */

import { createLogger } from "@q9labs/chalk-core";
import React, { useCallback, useEffect, useState } from "react";
import {
	DeviceEventEmitter,
	NativeEventEmitter,
	NativeModules,
	Platform,
} from "react-native";

const log = createLogger("AudioSession");

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
		log.warn("AudioSessionModule not available - native module not linked");
		return;
	}

	try {
		await AudioSessionModule.configureForCall();
		await AudioSessionModule.setSpeakerphone(useSpeaker);
		log.info(`Audio configured: speaker=${useSpeaker}`);
	} catch (err) {
		log.error("Audio config error", err);
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
			log.warn("AudioSessionModule not available");
			setIsSpeakerOn(newState);
			return;
		}

		try {
			await AudioSessionModule.setSpeakerphone(newState);
			setIsSpeakerOn(newState);
			log.debug(`Speakerphone: ${newState}`);
		} catch (err) {
			log.error("Speakerphone toggle error", err);
		}
	}, [isSpeakerOn]);

	const setSpeaker = useCallback(async (enabled: boolean) => {
		if (!AudioSessionModule) {
			log.warn("AudioSessionModule not available");
			setIsSpeakerOn(enabled);
			return;
		}

		try {
			await AudioSessionModule.setSpeakerphone(enabled);
			setIsSpeakerOn(enabled);
		} catch (err) {
			log.error("Speakerphone set error", err);
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
				log.debug("Route changed", event);
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
		} catch (err) {
			log.error("Bluetooth status check error", err);
		}
	}

	const connectBluetooth = useCallback(async () => {
		if (!AudioSessionModule) {
			return;
		}

		try {
			await AudioSessionModule.setOutputRoute("bluetooth");
			setIsBluetoothConnected(true);
		} catch (err) {
			log.error("Bluetooth connect error", err);
		}
	}, []);

	const disconnectBluetooth = useCallback(async () => {
		if (!AudioSessionModule) {
			return;
		}

		try {
			await AudioSessionModule.setOutputRoute("speaker");
			setIsBluetoothConnected(false);
		} catch (err) {
			log.error("Bluetooth disconnect error", err);
		}
	}, []);

	return {
		isBluetoothAvailable,
		isBluetoothConnected,
		connectBluetooth,
		disconnectBluetooth,
	};
}
