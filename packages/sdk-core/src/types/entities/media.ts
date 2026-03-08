/**
 * Media device and track types for Chalk SDK
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/types
 */

/**
 * Type of media device
 */
export type MediaDeviceKind = "videoinput" | "audioinput" | "audiooutput";

/**
 * Information about an available media device
 *
 * @example
 * ```ts
 * const devices = await session.media.refreshDevices();
 * const cameras = devices.filter(d => d.kind === 'videoinput');
 *
 * // Select a specific camera
 * await session.media.selectCamera(cameras[1].deviceId);
 * ```
 */
export interface MediaDevice {
	/** Unique device identifier for selection */
	deviceId: string;

	/** Human-readable device name */
	label: string;

	/** Type of device */
	kind: MediaDeviceKind;
}

/**
 * Type of media track
 */
export type TrackKind = "audio" | "video";

/**
 * Track source type
 */
export type TrackSource = "camera" | "microphone" | "screen" | "screen_audio";

/**
 * Represents a media track (audio or video)
 */
export interface Track {
	/** Unique track identifier */
	readonly id: string;

	/** Type of track (audio/video) */
	kind: TrackKind;

	/** Source of the track */
	source: TrackSource;

	/** Whether the track is currently enabled */
	enabled: boolean;

	/** Underlying browser MediaStreamTrack */
	mediaStreamTrack: MediaStreamTrack | null;
}

/**
 * Screen share options
 */
export interface ScreenShareOptions {
	/** Open annotation mode after the local share starts */
	withAnnotations?: boolean;

	/** Include system audio in the share (browser support varies) */
	withAudio?: boolean;

	/** Preferred display surface (monitor, window, browser) */
	preferredDisplaySurface?: "monitor" | "window" | "browser";
}

/**
 * Audio level information for a participant
 */
export interface AudioLevel {
	/** Participant ID */
	participantId: string;

	/** Audio level (0.0 to 1.0) */
	level: number;
}
