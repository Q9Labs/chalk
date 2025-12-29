import { useCallback, useRef, useState } from 'react';

export type SoundEffect = 
  | 'join' 
  | 'leave' 
  | 'message' 
  | 'handRaise' 
  | 'recordingStart' 
  | 'recordingStop' 
  | 'click' 
  | 'error' 
  | 'transcriptionReady' 
  | 'tourStep';

export interface UseSoundEffectsOptions {
  enabled?: boolean;
  volume?: number;
  basePath?: string;
}

export interface UseSoundEffectsReturn {
  playJoin: () => void;
  playLeave: () => void;
  playMessage: () => void;
  playHandRaise: () => void;
  playRecordingStart: () => void;
  playRecordingStop: () => void;
  playClick: () => void;
  playError: () => void;
  playTranscriptionReady: () => void;
  playTourStep: () => void;
  play: (sound: SoundEffect) => void;
  setEnabled: (enabled: boolean) => void;
  setVolume: (volume: number) => void;
  enabled: boolean;
  volume: number;
}

const SOUND_FILES: Record<SoundEffect, string> = {
  join: 'join.mp3',
  leave: 'leave.mp3',
  message: 'message.mp3',
  handRaise: 'hand-raise.mp3',
  recordingStart: 'recording-start.mp3',
  recordingStop: 'recording-stop.mp3',
  click: 'click.mp3',
  error: 'error.mp3',
  transcriptionReady: 'transcription-ready.mp3',
  tourStep: 'tour-step.mp3',
};

export function useSoundEffects(options: UseSoundEffectsOptions = {}): UseSoundEffectsReturn {
  const { 
    enabled: initialEnabled = true, 
    volume: initialVolume = 0.5,
    basePath = '/sounds'
  } = options;

  const [enabled, setEnabled] = useState(initialEnabled);
  const [volume, setVolume] = useState(initialVolume);
  const audioCache = useRef<Map<SoundEffect, HTMLAudioElement>>(new Map());

  const play = useCallback((sound: SoundEffect) => {
    if (!enabled || typeof window === 'undefined') return;

    let audio = audioCache.current.get(sound);
    
    if (!audio) {
      audio = new Audio(`${basePath}/${SOUND_FILES[sound]}`);
      audioCache.current.set(sound, audio);
    }

    audio.volume = Math.max(0, Math.min(1, volume));
    audio.currentTime = 0;
    audio.play().catch(() => {
      // Silently fail if autoplay is blocked
    });
  }, [enabled, volume, basePath]);

  return {
    playJoin: useCallback(() => play('join'), [play]),
    playLeave: useCallback(() => play('leave'), [play]),
    playMessage: useCallback(() => play('message'), [play]),
    playHandRaise: useCallback(() => play('handRaise'), [play]),
    playRecordingStart: useCallback(() => play('recordingStart'), [play]),
    playRecordingStop: useCallback(() => play('recordingStop'), [play]),
    playClick: useCallback(() => play('click'), [play]),
    playError: useCallback(() => play('error'), [play]),
    playTranscriptionReady: useCallback(() => play('transcriptionReady'), [play]),
    playTourStep: useCallback(() => play('tourStep'), [play]),
    play,
    setEnabled,
    setVolume,
    enabled,
    volume,
  };
}
