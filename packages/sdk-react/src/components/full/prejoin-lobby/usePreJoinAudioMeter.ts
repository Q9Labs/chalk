import { useEffect, useState } from "react";

export interface UsePreJoinAudioMeterParams {
	track: MediaStreamTrack | null;
	isAudioEnabled: boolean;
	externalAudioLevel?: number;
}

export interface UsePreJoinAudioMeterReturn {
	audioLevel: number;
}

export function usePreJoinAudioMeter({
	track,
	isAudioEnabled,
	externalAudioLevel,
}: UsePreJoinAudioMeterParams): UsePreJoinAudioMeterReturn {
	const [localAudioLevel, setLocalAudioLevel] = useState(0);

	useEffect(() => {
		if (externalAudioLevel !== undefined) return;

		if (!track || !isAudioEnabled) {
			setLocalAudioLevel(0);
			return;
		}

		const AudioContextCtor =
			(globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ??
			(globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
		if (!AudioContextCtor) return;

		let audioContext: AudioContext;
		try {
			audioContext = new AudioContextCtor();
		} catch {
			// Some browsers require a user gesture before constructing/resuming.
			return;
		}

		try {
			if (audioContext.state === "suspended") {
				void audioContext.resume().catch(() => {});
			}
		} catch {
			// ignore
		}

		const stream = new MediaStream([track]);
		const source = audioContext.createMediaStreamSource(stream);
		const analyser = audioContext.createAnalyser();
		analyser.fftSize = 256;
		analyser.smoothingTimeConstant = 0.5;
		source.connect(analyser);

		const dataArray = new Uint8Array(analyser.frequencyBinCount);
		let animationId: number | undefined;

		const updateLevel = () => {
			analyser.getByteFrequencyData(dataArray);

			let peak = 0;
			const voiceRange = Math.min(32, dataArray.length);
			for (let index = 0; index < voiceRange; index++) {
				const value = dataArray[index] ?? 0;
				if (value > peak) peak = value;
			}

			const normalized = peak / 255;
			setLocalAudioLevel(Math.min(1, normalized * 1.5));
			animationId = requestAnimationFrame(updateLevel);
		};

		updateLevel();

		return () => {
			if (typeof animationId === "number") cancelAnimationFrame(animationId);
			void audioContext.close().catch(() => {});
		};
	}, [track, externalAudioLevel, isAudioEnabled]);

	return {
		audioLevel: externalAudioLevel ?? localAudioLevel,
	};
}
