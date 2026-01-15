/**
 * RTCManager - Native WebRTC wrapper for React Native
 * Integrates with @cloudflare/realtimekit-react-native for WebRTC functionality
 * Falls back to raw react-native-webrtc when RealtimeKit is not available
 */

import { createLogger } from "@q9labs/chalk-core";
import { PermissionsAndroid, Platform } from "react-native";
import type { MediaStream, RTCPeerConnection } from "@cloudflare/react-native-webrtc";

// Dynamic import to handle cases where native module isn't initialized
let mediaDevices: typeof import("@cloudflare/react-native-webrtc").mediaDevices | null =
	null;
try {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	mediaDevices = require("@cloudflare/react-native-webrtc").mediaDevices;
} catch {
	// Native module not available (e.g., running in simulator without full setup)
}

const log = createLogger("RTCManager");

// RealtimeKit client type definition
// The actual import is dynamic to allow fallback when package is not available
interface RealtimeKitSelf {
	videoEnabled: boolean;
	audioEnabled: boolean;
	screenShareEnabled?: boolean;
	enableVideo: () => Promise<void>;
	disableVideo: () => Promise<void>;
	enableAudio: () => Promise<void>;
	disableAudio: () => Promise<void>;
	enableScreenShare: () => Promise<void>;
	disableScreenShare: () => Promise<void>;
}

interface RealtimeKitClientInstance {
	self: RealtimeKitSelf;
	join: () => Promise<void>;
	leave: () => Promise<void>;
}

interface RealtimeKitInitOptions {
	authToken: string;
	defaults?: {
		audio?: boolean;
		video?: boolean;
	};
}

// Dynamic import helper for RealtimeKit
let RealtimeKitClient: {
	init: (options: RealtimeKitInitOptions) => Promise<RealtimeKitClientInstance>;
} | null = null;

try {
	// Attempt to load RealtimeKit - this may fail if not installed
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	RealtimeKitClient = require("@cloudflare/realtimekit-react-native").default;
} catch {
	// RealtimeKit not available, will use fallback mode
	log.info("RealtimeKit not available, using fallback mode");
}

export interface MediaDeviceInfo {
	deviceId: string;
	label: string;
	kind: "audioinput" | "audiooutput" | "videoinput";
}

export interface RTCManagerInitOptions {
	audio?: boolean;
	video?: boolean;
}

/**
 * RTCManager handles WebRTC media stream management and device selection
 * for React Native applications.
 *
 * Primary mode: Uses @cloudflare/realtimekit-react-native for WebRTC
 * Fallback mode: Uses raw react-native-webrtc when RealtimeKit is not available
 */
export class RTCManager {
	private rtkClient: RealtimeKitClientInstance | null = null;
	private localStream: MediaStream | null = null;
	private peerConnections: Map<string, RTCPeerConnection> = new Map();
	private cameraFacingMode: "user" | "environment" = "user";
	private isUsingRealtimeKit = false;
	private isScreenSharing = false;

	/**
	 * Initialize with RealtimeKit auth token
	 * This is the preferred initialization method when using RealtimeKit
	 */
	async initializeWithToken(
		authToken: string,
		options?: RTCManagerInitOptions,
	): Promise<void> {
		const hasPermissions = await this.requestPermissions();
		if (!hasPermissions) {
			throw new Error("Media permissions denied");
		}

		if (!RealtimeKitClient) {
			throw new Error(
				"RealtimeKit is not available. Install @cloudflare/realtimekit-react-native",
			);
		}

		this.rtkClient = await RealtimeKitClient.init({
			authToken,
			defaults: {
				audio: options?.audio ?? true,
				video: options?.video ?? true,
			},
		});

		this.isUsingRealtimeKit = true;
	}

	/**
	 * Join room via RealtimeKit
	 */
	async joinRoom(): Promise<void> {
		if (!this.rtkClient) {
			throw new Error("RTCManager not initialized with RealtimeKit");
		}
		await this.rtkClient.join();
	}

	/**
	 * Leave room
	 */
	async leaveRoom(): Promise<void> {
		if (this.rtkClient) {
			await this.rtkClient.leave();
		}
	}

	/**
	 * Get the RealtimeKit client instance
	 */
	getRtkClient(): RealtimeKitClientInstance | null {
		return this.rtkClient;
	}

	/**
	 * Check if using RealtimeKit mode
	 */
	isRealtimeKitMode(): boolean {
		return this.isUsingRealtimeKit && this.rtkClient !== null;
	}

	/**
	 * Request camera and microphone permissions
	 * iOS permissions are handled via Info.plist
	 */
	async requestPermissions(): Promise<boolean> {
		if (Platform.OS === "android") {
			try {
				const permissions = [
					PermissionsAndroid.PERMISSIONS.CAMERA,
					PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
				];

				const granted = await PermissionsAndroid.requestMultiple(permissions);

				return (
					granted[PermissionsAndroid.PERMISSIONS.CAMERA] === "granted" &&
					granted[PermissionsAndroid.PERMISSIONS.RECORD_AUDIO] === "granted"
				);
			} catch (err) {
				log.error("Permission request error", err);
				return false;
			}
		}

		// iOS permissions handled via Info.plist
		return true;
	}

	/**
	 * Toggle video using RealtimeKit or fallback
	 */
	async toggleVideo(): Promise<boolean> {
		// RealtimeKit mode
		if (this.rtkClient) {
			if (this.rtkClient.self.videoEnabled) {
				await this.rtkClient.self.disableVideo();
				return false;
			}
			await this.rtkClient.self.enableVideo();
			return true;
		}

		// Fallback mode
		if (this.localStream) {
			const videoTracks = this.localStream.getVideoTracks();
			if (videoTracks.length > 0) {
				const track = videoTracks[0] as unknown as { enabled: boolean };
				track.enabled = !track.enabled;
				return track.enabled;
			}
		}
		return false;
	}

	/**
	 * Toggle audio using RealtimeKit or fallback
	 */
	async toggleAudio(): Promise<boolean> {
		// RealtimeKit mode
		if (this.rtkClient) {
			if (this.rtkClient.self.audioEnabled) {
				await this.rtkClient.self.disableAudio();
				return false;
			}
			await this.rtkClient.self.enableAudio();
			return true;
		}

		// Fallback mode
		if (this.localStream) {
			const audioTracks = this.localStream.getAudioTracks();
			if (audioTracks.length > 0) {
				const track = audioTracks[0] as unknown as { enabled: boolean };
				track.enabled = !track.enabled;
				return track.enabled;
			}
		}
		return false;
	}

	/**
	 * Start screen sharing via RealtimeKit
	 * Note: Screen sharing requires additional native setup on iOS/Android
	 */
	async startScreenShare(): Promise<boolean> {
		if (!this.rtkClient) {
			log.error("Screen share requires RealtimeKit");
			return false;
		}

		try {
			await this.rtkClient.self.enableScreenShare();
			this.isScreenSharing = true;
			return true;
		} catch (error) {
			log.error("Screen share failed", error);
			return false;
		}
	}

	/**
	 * Stop screen sharing
	 */
	async stopScreenShare(): Promise<void> {
		if (this.rtkClient) {
			try {
				await this.rtkClient.self.disableScreenShare();
				this.isScreenSharing = false;
			} catch (error) {
				log.error("Stop screen share failed", error);
			}
		}
	}

	/**
	 * Check if screen sharing is active
	 */
	getIsScreenSharing(): boolean {
		if (this.rtkClient) {
			return this.rtkClient.self.screenShareEnabled ?? this.isScreenSharing;
		}
		return this.isScreenSharing;
	}

	/**
	 * Get the local media stream with video and/or audio
	 * Used in fallback mode when RealtimeKit is not available
	 */
	async getLocalStream(
		video: boolean = true,
		audio: boolean = true,
	): Promise<MediaStream> {
		if (!mediaDevices) {
			log.warn("mediaDevices not available - running in limited mode");
			throw new Error("WebRTC not available on this device");
		}

		const constraints = {
			audio: audio
				? {
						echoCancellation: true,
						noiseSuppression: true,
						autoGainControl: true,
					}
				: false,
			video: video
				? {
						facingMode: this.cameraFacingMode,
						width: { ideal: 1280 },
						height: { ideal: 720 },
					}
				: false,
		};

		try {
			this.localStream = await mediaDevices.getUserMedia(constraints);
			return this.localStream;
		} catch (err) {
			log.error("getUserMedia error", err);
			throw err;
		}
	}

	/**
	 * Get all available media devices
	 */
	async enumerateDevices(): Promise<MediaDeviceInfo[]> {
		if (!mediaDevices) {
			log.warn("mediaDevices not available - returning mock devices");
			// Return mock devices for simulator/testing
			return [
				{ deviceId: "mock-camera-front", label: "Front Camera", kind: "videoinput" },
				{ deviceId: "mock-camera-back", label: "Back Camera", kind: "videoinput" },
				{ deviceId: "mock-mic", label: "Built-in Microphone", kind: "audioinput" },
				{ deviceId: "mock-speaker", label: "Built-in Speaker", kind: "audiooutput" },
			];
		}

		try {
			const devices = await mediaDevices.enumerateDevices();
			return devices as MediaDeviceInfo[];
		} catch (err) {
			log.error("enumerateDevices error", err);
			return [];
		}
	}

	/**
	 * Get list of camera devices
	 */
	async getCameras(): Promise<MediaDeviceInfo[]> {
		const devices = await this.enumerateDevices();
		return devices.filter((d) => d.kind === "videoinput");
	}

	/**
	 * Get list of microphone devices
	 */
	async getMicrophones(): Promise<MediaDeviceInfo[]> {
		const devices = await this.enumerateDevices();
		return devices.filter((d) => d.kind === "audioinput");
	}

	/**
	 * Get list of speaker devices
	 */
	async getSpeakers(): Promise<MediaDeviceInfo[]> {
		const devices = await this.enumerateDevices();
		return devices.filter((d) => d.kind === "audiooutput");
	}

	/**
	 * Switch between front and back camera
	 */
	async switchCamera(): Promise<void> {
		if (!this.localStream) {
			throw new Error("No local stream available");
		}

		try {
			const videoTrack = this.localStream.getVideoTracks()[0];
			if (videoTrack) {
				// Call the native method if available
				if (
					(videoTrack as unknown as { _switchCamera?: () => void })
						._switchCamera
				) {
					(
						videoTrack as unknown as { _switchCamera: () => void }
					)._switchCamera();
					this.cameraFacingMode =
						this.cameraFacingMode === "user" ? "environment" : "user";
				} else {
					// Fallback: stop current stream and get new one
					await this.stopVideo();
					this.cameraFacingMode =
						this.cameraFacingMode === "user" ? "environment" : "user";
					await this.startVideo();
				}
			}
		} catch (err) {
			log.error("switchCamera error", err);
			throw err;
		}
	}

	/**
	 * Get current camera facing mode
	 */
	getCameraFacingMode(): "user" | "environment" {
		return this.cameraFacingMode;
	}

	/**
	 * Start video on local stream (fallback mode)
	 */
	async startVideo(): Promise<void> {
		if (!mediaDevices) {
			log.warn("startVideo: mediaDevices not available");
			return;
		}

		if (!this.localStream) {
			this.localStream = await this.getLocalStream(true, true);
			return;
		}

		const videoTrack = this.localStream.getVideoTracks()[0];
		if (videoTrack) {
			(videoTrack as unknown as { enabled: boolean }).enabled = true;
		} else {
			// No video track exists, get a new stream
			const constraints = {
				video: {
					facingMode: this.cameraFacingMode,
					width: { ideal: 1280 },
					height: { ideal: 720 },
				},
				audio: false,
			};

			try {
				const stream = await mediaDevices.getUserMedia(constraints);
				const newVideoTrack = stream.getVideoTracks()[0];
				if (newVideoTrack) {
					this.localStream.addTrack(newVideoTrack);
				}
			} catch (err) {
				log.error("startVideo error", err);
				throw err;
			}
		}
	}

	/**
	 * Stop video on local stream (fallback mode)
	 */
	async stopVideo(): Promise<void> {
		if (this.localStream) {
			const videoTracks = this.localStream.getVideoTracks();
			for (const track of videoTracks) {
				const t = track as { enabled: boolean };
				t.enabled = false;
				this.localStream?.removeTrack(track as MediaStream);
			}
		}
	}

	/**
	 * Toggle video enabled state (fallback mode)
	 * @deprecated Use toggleVideo() instead
	 */
	toggleVideoLegacy(enabled: boolean): void {
		if (this.localStream) {
			for (const track of this.localStream.getVideoTracks()) {
				const t = track as unknown as { enabled: boolean };
				t.enabled = enabled;
			}
		}
	}

	/**
	 * Start audio on local stream (fallback mode)
	 */
	async startAudio(): Promise<void> {
		if (!mediaDevices) {
			log.warn("startAudio: mediaDevices not available");
			return;
		}

		if (!this.localStream) {
			this.localStream = await this.getLocalStream(false, true);
			return;
		}

		const audioTrack = this.localStream.getAudioTracks()[0];
		if (audioTrack) {
			(audioTrack as unknown as { enabled: boolean }).enabled = true;
		} else {
			// No audio track exists, get a new stream
			const constraints = {
				audio: {
					echoCancellation: true,
					noiseSuppression: true,
					autoGainControl: true,
				},
				video: false,
			};

			try {
				const stream = await mediaDevices.getUserMedia(constraints);
				const newAudioTrack = stream.getAudioTracks()[0];
				if (newAudioTrack) {
					this.localStream.addTrack(newAudioTrack);
				}
			} catch (err) {
				log.error("startAudio error", err);
				throw err;
			}
		}
	}

	/**
	 * Stop audio on local stream (fallback mode)
	 */
	async stopAudio(): Promise<void> {
		if (this.localStream) {
			const audioTracks = this.localStream.getAudioTracks();
			for (const track of audioTracks) {
				const t = track as { enabled: boolean };
				t.enabled = false;
				this.localStream?.removeTrack(track as MediaStream);
			}
		}
	}

	/**
	 * Toggle audio enabled state (fallback mode)
	 * @deprecated Use toggleAudio() instead
	 */
	toggleAudioLegacy(enabled: boolean): void {
		if (this.localStream) {
			for (const track of this.localStream.getAudioTracks()) {
				const t = track as unknown as { enabled: boolean };
				t.enabled = enabled;
			}
		}
	}

	/**
	 * Get the current local stream
	 */
	getLocalStreamInstance(): MediaStream | null {
		return this.localStream;
	}

	/**
	 * Clean up resources
	 */
	cleanup(): void {
		// Clean up RealtimeKit
		if (this.rtkClient) {
			this.rtkClient.leave().catch((err) => {
				log.error("Error leaving room during cleanup", err);
			});
			this.rtkClient = null;
		}

		// Clean up local stream
		if (this.localStream) {
			for (const track of this.localStream.getTracks()) {
				const t = track as { stop: () => void };
				t.stop();
			}
			this.localStream = null;
		}

		// Clean up peer connections
		for (const pc of this.peerConnections.values()) {
			pc.close();
		}
		this.peerConnections.clear();

		this.isUsingRealtimeKit = false;
		this.isScreenSharing = false;
	}
}
