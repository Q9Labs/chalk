import { useCallback, useEffect, useRef, useState } from 'react';
import { useChalkSession } from '../context/chalk-provider';

export type SoundEffect =
  | 'join'
  | 'leave'
  | 'message'
  | 'handRaise'
  | 'reaction'
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
  autoSubscribe?: boolean;
}

export interface UseSoundEffectsReturn {
  playJoin: () => void;
  playLeave: () => void;
  playMessage: () => void;
  playHandRaise: () => void;
  playReaction: () => void;
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
  reaction: 'reaction.mp3',
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
    basePath = '/sounds',
    autoSubscribe = false,
  } = options;

  const { session } = useChalkSession();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [volume, setVolume] = useState(initialVolume);
  const audioCache = useRef<Map<SoundEffect, HTMLAudioElement>>(new Map());

  const play = useCallback((sound: SoundEffect) => {
    if (!enabled || typeof window === 'undefined') return;

    const soundPath = `${basePath}/${SOUND_FILES[sound]}`;
    let audio = audioCache.current.get(sound);

    if (!audio) {
      audio = new Audio(soundPath);
      audioCache.current.set(sound, audio);
    }

    audio.volume = Math.max(0, Math.min(1, volume));
    audio.currentTime = 0;
    audio.play().catch(() => {
      // Silently fail if autoplay blocked
    });
  }, [enabled, volume, basePath]);

  // Auto-subscribe to session events
  useEffect(() => {
    if (!autoSubscribe || !session || !enabled) return;

    const unsubscribers: (() => void)[] = [];

    // Play join sound on connected
    unsubscribers.push(
      session.on('connected', () => {
        play('join');
      })
    );

    // Play leave sound on disconnected
    unsubscribers.push(
      session.on('disconnected', () => {
        play('leave');
      })
    );

    // Subscribe to participant manager events
    unsubscribers.push(
      session.participants.on('participant:joined', () => {
        play('join');
      })
    );

    unsubscribers.push(
      session.participants.on('participant:left', () => {
        play('leave');
      })
    );

    // Subscribe to chat manager events
    const localId = session.participants.getState().localParticipant?.id;
    unsubscribers.push(
      session.chat.on('message', ({ message }) => {
        if (message.senderId !== localId) {
          play('message');
        }
      })
    );

    // Subscribe to interaction manager events
    unsubscribers.push(
      session.interactions.on('hand:raised', () => {
        play('handRaise');
      })
    );

    // Subscribe to recording manager events
    unsubscribers.push(
      session.recording.on('started', () => {
        play('recordingStart');
      })
    );

    unsubscribers.push(
      session.recording.on('stopped', () => {
        play('recordingStop');
      })
    );

    // Subscribe to error events
    unsubscribers.push(
      session.on('error', () => {
        play('error');
      })
    );

    return () => {
      unsubscribers.forEach(unsub => unsub());
    };
  }, [autoSubscribe, session, enabled, play]);

  return {
    playJoin: useCallback(() => play('join'), [play]),
    playLeave: useCallback(() => play('leave'), [play]),
    playMessage: useCallback(() => play('message'), [play]),
    playHandRaise: useCallback(() => play('handRaise'), [play]),
    playReaction: useCallback(() => play('reaction'), [play]),
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
