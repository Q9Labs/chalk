/**
 * @chalk/react-native - React Native SDK for Chalk video conferencing
 *
 * This package provides React Native bindings for the Chalk video conferencing platform.
 * It wraps the Cloudflare RealtimeKit React Native SDK.
 *
 * NOTE: This is a placeholder - full implementation requires:
 * 1. Cloudflare RealtimeKit React Native SDK integration
 * 2. Native module bridges for iOS and Android
 * 3. Permission handling for camera/microphone
 */

// Re-export core types for convenience
export type {
	ChalkClientConfig,
	ChatMessage,
	Participant,
	Reaction,
	ReactionEmoji,
	Recording,
	RoomConfig,
	RoomInfo,
	RoomStatus,
} from "@chalk/core";

// Placeholder exports - to be implemented
export const ChalkReactNative = {
	version: "0.0.1",
	isSupported: () => {
		console.warn("@chalk/react-native is not yet fully implemented");
		return false;
	},
};

// TODO: Implement native components
// export { ChalkProvider } from './ChalkProvider';
// export { useRoom, useParticipants, useMedia, useChat } from './hooks';
// export { VideoView, ScreenShareView } from './components';
