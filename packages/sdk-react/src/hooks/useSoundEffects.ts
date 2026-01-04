import { useCallback, useEffect, useRef, useState } from 'react';
import { useChalk } from '../context';

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
  autoSubscribe?: boolean;
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
    basePath = '/sounds',
    autoSubscribe = false,
  } = options;

  const { room } = useChalk();
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

  // Auto-subscribe to room events
  useEffect(() => {
    if (!autoSubscribe || !room || !enabled) return;

    const localId = room.localParticipant?.id;

    // Play join sound immediately if room is already connected (subscribed after connection)
    if (room.status === 'connected') {
      play('join');
    }

    // Play sounds on future status changes
    const unsubStatus = room.on('status-changed', (status) => {
      if (status === 'connected') {
        play('join');
      } else if (status === 'disconnected') {
        play('leave');
      }
    });

    // Play join sound when remote participants join
    const unsubJoin = room.on('participant-joined', () => {
      play('join');
    });

    // Play leave sound when remote participants leave
    const unsubLeave = room.on('participant-left', () => {
      play('leave');
    });

    const unsubMessage = room.on('chat-message', (msg) => {
      // Only play for messages from others
      if (msg.senderId !== localId) {
        play('message');
      }
    });

    const unsubHandRaised = room.on('hand-raised', () => {
      play('handRaise');
    });

    const unsubRecordingStart = room.on('recording-started', () => {
      play('recordingStart');
    });

    const unsubRecordingStop = room.on('recording-stopped', () => {
      play('recordingStop');
    });

    const unsubError = room.on('error', () => {
      play('error');
    });

    return () => {
      unsubStatus();
      unsubJoin();
      unsubLeave();
      unsubMessage();
      unsubHandRaised();
      unsubRecordingStart();
      unsubRecordingStop();
      unsubError();
    };
  }, [autoSubscribe, room, enabled, play]);

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
