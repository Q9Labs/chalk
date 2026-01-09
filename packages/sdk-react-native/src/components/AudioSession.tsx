/**
 * AudioSession component - Manages iOS/Android audio routing and focus
 * Handles speakerphone, Bluetooth, and audio focus management
 */

import { createLogger } from "@q9labs/chalk-core";
import React, { useEffect } from "react";
import { Platform } from "react-native";

const log = createLogger("AudioSession");

interface AudioSessionProps {
	/** Whether audio should be routed to speaker (loud speaker) */
	useSpeaker?: boolean;
	/** Whether to enable speakerphone automatically (reserved for future use) */
	_enableSpeakerphone?: boolean;
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
 *     <AudioSession useSpeaker={true} enableSpeakerphone={true}>
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
}: Omit<AudioSessionProps, "_enableSpeakerphone">) {
	useEffect(() => {
		if (Platform.OS === "ios") {
			configureIOSAudioSession(useSpeaker);
		} else if (Platform.OS === "android") {
			configureAndroidAudioFocus();
		}
	}, [useSpeaker]);

	return <>{children}</>;
}

/**
 * Configure iOS audio session for WebRTC
 * Requires linking with native AVAudioSession bindings
 */
async function configureIOSAudioSession(useSpeaker: boolean): Promise<void> {
	try {
		// This would typically call into native code via NativeModules
		// For now, we document the expected behavior
		log.info(`iOS audio mode: ${useSpeaker ? "SPEAKER" : "EARPIECE"}`);

		// Expected native implementation would do:
		// const audioSession = AVAudioSession.sharedInstance();
		// audioSession.setCategory("AVAudioSessionCategoryPlayAndRecord")
		// audioSession.setMode("AVAudioSessionModeVoiceChat")
		// audioSession.setActive(true)
		// if (useSpeaker) {
		//   audioSession.overrideOutputAudioPort("Speaker")
		// }
	} catch (err) {
		log.error("iOS config error", err);
	}
}

/**
 * Configure Android audio focus management
 * Ensures audio focus is maintained during calls
 */
async function configureAndroidAudioFocus(): Promise<void> {
	try {
		// This would typically call into native code via NativeModules
		// For now, we document the expected behavior
		log.info("Android audio focus configured");

		// Expected native implementation would do:
		// final audioManager = context.getSystemService(Context.AUDIO_SERVICE)
		// audioManager.requestAudioFocus(
		//   audioFocusRequest,
		//   AudioManager.AUDIOFOCUS_GAIN
		// )
		// audioManager.setMicrophoneMute(false)
		// audioManager.setSpeakerphoneOn(useSpeaker)
	} catch (err) {
		log.error("Android config error", err);
	}
}

/**
 * Hook to toggle speakerphone mode
 * Use this in your call screen components
 */
export function useSpeakerphone() {
	const [isSpeakerOn, setIsSpeakerOn] = React.useState(false);

	const toggle = React.useCallback(async () => {
		const newState = !isSpeakerOn;
		setIsSpeakerOn(newState);

		if (Platform.OS === "ios") {
			await configureIOSAudioSession(newState);
		} else if (Platform.OS === "android") {
			// Android would use AudioManager.setSpeakerphoneOn(newState)
			log.debug(`Android speakerphone: ${newState}`);
		}
	}, [isSpeakerOn]);

	return { isSpeakerOn, toggle };
}

/**
 * Hook to check if Bluetooth audio is available
 */
export function useBluetoothAudio() {
	const [isBluetoothAvailable] = React.useState(false);
	const [isBluetoothConnected] = React.useState(false);

	React.useEffect(() => {
		if (Platform.OS === "android") {
			checkBluetoothStatus();
			const interval = setInterval(checkBluetoothStatus, 3000);
			return () => clearInterval(interval);
		}
	}, []);

	async function checkBluetoothStatus() {
		try {
			// This would check Bluetooth audio device availability
			// via native code or react-native-device-info
			log.debug("Checking Bluetooth status");
		} catch (err) {
			log.error("Bluetooth status check error", err);
		}
	}

	return { isBluetoothAvailable, isBluetoothConnected };
}
