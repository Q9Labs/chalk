/**
 * Type declarations for @cloudflare/react-native-webrtc
 * Re-exports same types as react-native-webrtc with Cloudflare modifications
 */

declare module "@cloudflare/react-native-webrtc" {
	import type { ViewProps } from "react-native";

	export interface MediaStream {
		toURL(): string;
		getTracks(): unknown[];
		getVideoTracks(): unknown[];
		getAudioTracks(): unknown[];
		addTrack(track: unknown): void;
		removeTrack(track: unknown): void;
	}

	export interface RTCPeerConnection {
		close(): void;
	}

	export const mediaDevices: {
		getUserMedia(constraints: object): Promise<MediaStream>;
		enumerateDevices(): Promise<
			Array<{
				deviceId: string;
				label: string;
				kind: "audioinput" | "audiooutput" | "videoinput";
			}>
		>;
	};

	export interface RTCViewProps extends ViewProps {
		streamURL: string;
		mirror?: boolean;
		objectFit?: "contain" | "cover";
		zOrder?: number;
	}

	export const RTCView: React.ForwardRefExoticComponent<
		RTCViewProps & React.RefAttributes<unknown>
	>;
}

/**
 * Type declarations for @cloudflare/realtimekit
 * The core RTK client exposed by @cloudflare/realtimekit-react-native
 */

declare module "@cloudflare/realtimekit" {
	export interface RealtimeKitSelf {
		videoEnabled: boolean;
		audioEnabled: boolean;
		screenShareEnabled?: boolean;
		videoTrack?: MediaStreamTrack | null;
		audioTrack?: MediaStreamTrack | null;
		enableVideo(): Promise<void>;
		disableVideo(): Promise<void>;
		enableAudio(): Promise<void>;
		disableAudio(): Promise<void>;
		enableScreenShare(): Promise<void>;
		disableScreenShare(): Promise<void>;
	}

	export interface RealtimeKitParticipant {
		id: string;
		name: string;
		videoEnabled: boolean;
		audioEnabled: boolean;
		screenShareEnabled?: boolean;
		videoTrack?: MediaStreamTrack | null;
		audioTrack?: MediaStreamTrack | null;
	}

	export interface RealtimeKitParticipantEvents {
		on(event: "participantJoined", callback: (participant: RealtimeKitParticipant) => void): () => void;
		on(event: "participantLeft", callback: (participant: RealtimeKitParticipant) => void): () => void;
		on(event: "videoUpdate", callback: (participant: RealtimeKitParticipant) => void): () => void;
		on(event: "audioUpdate", callback: (participant: RealtimeKitParticipant) => void): () => void;
		joined: {
			on(event: "participantJoined", callback: (participant: RealtimeKitParticipant) => void): () => void;
			on(event: "participantLeft", callback: (participant: RealtimeKitParticipant) => void): () => void;
			on(event: "videoUpdate", callback: (participant: RealtimeKitParticipant) => void): () => void;
			on(event: "audioUpdate", callback: (participant: RealtimeKitParticipant) => void): () => void;
		};
		toArray(): RealtimeKitParticipant[];
	}

	export interface RealtimeKitClientOptions {
		authToken: string;
		defaults?: {
			audio?: boolean;
			video?: boolean;
		};
	}

	export default class RealtimeKitClient {
		static init(options: RealtimeKitClientOptions): Promise<RealtimeKitClient>;
		self: RealtimeKitSelf;
		participants: RealtimeKitParticipantEvents;
		join(): Promise<void>;
		leave(): Promise<void>;
	}
}

/**
 * Type declarations for @cloudflare/realtimekit-react-native
 * React Native bindings for RealtimeKit
 */

declare module "@cloudflare/realtimekit-react-native" {
	import type RealtimeKitClient from "@cloudflare/realtimekit";
	import type { RealtimeKitClientOptions } from "@cloudflare/realtimekit";
	import type { ReactNode } from "react";

	export function useRealtimeKitClient(): [
		RealtimeKitClient | undefined,
		(options: RealtimeKitClientOptions) => void,
	];

	export function useRealtimeKitSelector<StateSlice>(
		selector: (state: RealtimeKitClient) => StateSlice,
	): StateSlice;

	export function useRealtimeKitMeeting(): {
		meeting: RealtimeKitClient;
	};

	export function RealtimeKitProvider(props: {
		value: RealtimeKitClient | undefined;
		children: ReactNode;
		fallback?: ReactNode;
	}): JSX.Element;

	export default RealtimeKitClient;
}
