/**
 * Type declarations for react-native-webrtc
 * Until full types are available from the library
 */

declare module "react-native-webrtc" {
	import type { ReactNode } from "react";
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
