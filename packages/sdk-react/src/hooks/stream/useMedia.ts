/**
 * useMedia - Control video/audio from MediaManager
 */

import type {
	MediaDevice,
	MediaState,
	VideoBackgroundEffect,
} from "@q9labs/chalk-core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "../../context/chalk-provider";

export interface UseMediaReturn {
	/** Whether video is enabled */
	isVideoEnabled: boolean;
	/** Whether audio is enabled */
	isAudioEnabled: boolean;
	/** Whether video toggle is in progress */
	isTogglingVideo: boolean;
	/** Whether audio toggle is in progress */
	isTogglingAudio: boolean;
	/** All available devices */
	devices: readonly MediaDevice[];
	/** Available cameras */
	cameras: readonly MediaDevice[];
	/** Available microphones */
	microphones: readonly MediaDevice[];
	/** Available speakers */
	speakers: readonly MediaDevice[];
	/** Selected camera device ID */
	selectedCamera: string | null;
	/** Selected microphone device ID */
	selectedMicrophone: string | null;
	/** Selected speaker device ID */
	selectedSpeaker: string | null;
	/** Whether background effects are supported in this browser/runtime */
	isBackgroundEffectsSupported: boolean;
	/** Whether a background effect change is in progress */
	isApplyingBackgroundEffect: boolean;
	/** Currently selected runtime background effect */
	selectedBackgroundEffect: VideoBackgroundEffect;
	/** Toggle video on/off */
	toggleVideo: () => Promise<boolean>;
	/** Toggle audio on/off */
	toggleAudio: () => Promise<boolean>;
	/** Apply a local video background effect */
	applyBackgroundEffect: (effect: VideoBackgroundEffect) => Promise<void>;
	/** Clear any active local video background effect */
	clearBackgroundEffect: () => Promise<void>;
	/** Select a camera */
	selectCamera: (deviceId: string) => Promise<void>;
	/** Select a microphone */
	selectMicrophone: (deviceId: string) => Promise<void>;
	/** Select a speaker */
	selectSpeaker: (deviceId: string) => Promise<void>;
	/** Refresh device list */
	refreshDevices: () => Promise<readonly MediaDevice[]>;
	/** Undo last device change (within 5s) */
	undoDeviceChange: () => void;
}

/**
 * Hook for controlling video/audio and devices
 *
 * @example
 * ```tsx
 * function MediaControls() {
 *   const {
 *     isVideoEnabled,
 *     isAudioEnabled,
 *     toggleVideo,
 *     toggleAudio,
 *     isTogglingVideo,
 *   } = useMedia();
 *
 *   return (
 *     <div>
 *       <button onClick={toggleVideo} disabled={isTogglingVideo}>
 *         {isVideoEnabled ? 'Stop Video' : 'Start Video'}
 *       </button>
 *       <button onClick={toggleAudio}>
 *         {isAudioEnabled ? 'Mute' : 'Unmute'}
 *       </button>
 *     </div>
 *   );
 * }
 * ```
 */
export function useMedia(): UseMediaReturn {
	const session = useSession();
	const { media } = session;

	const [state, setState] = useState<MediaState>(() => media.getState());

	useEffect(() => {
		return media.subscribe(setState);
	}, [media]);

	const toggleVideo = useCallback(
		(): Promise<boolean> => media.toggleVideo(),
		[media],
	);

	const toggleAudio = useCallback(
		(): Promise<boolean> => media.toggleAudio(),
		[media],
	);

	const selectCamera = useCallback(
		(deviceId: string): Promise<void> => media.selectCamera(deviceId),
		[media],
	);

	const applyBackgroundEffect = useCallback(
		(effect: VideoBackgroundEffect): Promise<void> =>
			media.applyBackgroundEffect(effect),
		[media],
	);

	const clearBackgroundEffect = useCallback(
		(): Promise<void> => media.clearBackgroundEffect(),
		[media],
	);

	const selectMicrophone = useCallback(
		(deviceId: string): Promise<void> => media.selectMicrophone(deviceId),
		[media],
	);

	const selectSpeaker = useCallback(
		(deviceId: string): Promise<void> => media.selectSpeaker(deviceId),
		[media],
	);

	const refreshDevices = useCallback(
		(): Promise<readonly MediaDevice[]> => media.refreshDevices(),
		[media],
	);

	const undoDeviceChange = useCallback(
		(): void => media.undoDeviceChange(),
		[media],
	);

	return useMemo(
		(): UseMediaReturn => ({
			isVideoEnabled: state.isVideoEnabled,
			isAudioEnabled: state.isAudioEnabled,
			isTogglingVideo: state.isTogglingVideo,
			isTogglingAudio: state.isTogglingAudio,
			devices: state.devices,
			cameras: media.cameras,
			microphones: media.microphones,
			speakers: media.speakers,
			isBackgroundEffectsSupported: state.isBackgroundEffectsSupported,
			isApplyingBackgroundEffect: state.isApplyingBackgroundEffect,
			selectedCamera: state.selectedCamera,
			selectedBackgroundEffect: state.selectedBackgroundEffect,
			selectedMicrophone: state.selectedMicrophone,
			selectedSpeaker: state.selectedSpeaker,
			applyBackgroundEffect,
			clearBackgroundEffect,
			toggleVideo,
			toggleAudio,
			selectCamera,
			selectMicrophone,
			selectSpeaker,
			refreshDevices,
			undoDeviceChange,
		}),
		[
			state,
			media,
			applyBackgroundEffect,
			clearBackgroundEffect,
			toggleVideo,
			toggleAudio,
			selectCamera,
			selectMicrophone,
			selectSpeaker,
			refreshDevices,
			undoDeviceChange,
		],
	);
}
