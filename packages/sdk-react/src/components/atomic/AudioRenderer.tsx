/**
 * AudioRenderer - Renders hidden audio elements for remote participants
 *
 * WebRTC audio tracks must be attached to HTML audio elements to be heard.
 * This component creates and manages audio elements for all remote participants.
 *
 * Usage: Place once in your room component, passing all remote participants.
 */

import { useEffect, useRef } from 'react';

export interface AudioParticipant {
  id: string;
  audioTrack?: MediaStreamTrack | null;
  screenShareAudioTrack?: MediaStreamTrack | null;
  isLocal?: boolean;
}

export interface AudioRendererProps {
  /** All participants - will filter to remote participants with audio tracks */
  participants: AudioParticipant[];
  /** Volume level 0-1 (default: 1) */
  volume?: number;
  /** Per-participant volume override (0-1). Takes precedence over volume prop. */
  getParticipantVolume?: (participantId: string) => number;
}

/**
 * Renders audio for all remote participants.
 * Must be included once in your room to hear other participants.
 */
export function AudioRenderer({ participants, volume = 1, getParticipantVolume }: AudioRendererProps) {
  // Map of participant ID -> audio element (mic audio)
  const audioElementsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  // Map of participant ID -> audio element (screen share audio)
  const screenShareAudioRef = useRef<Map<string, HTMLAudioElement>>(new Map());

  // Filter to remote participants with valid audio tracks
  const remoteWithAudio = participants.filter((p) => {
    if (p.isLocal) return false;
    if (!p.audioTrack) return false;
    try {
      return p.audioTrack.readyState === 'live';
    } catch {
      // Track may have been disposed
      return false;
    }
  });

  // Filter to remote participants with valid screen share audio tracks
  const remoteWithScreenShareAudio = participants.filter((p) => {
    if (p.isLocal) return false;
    if (!p.screenShareAudioTrack) return false;
    try {
      return p.screenShareAudioTrack.readyState === 'live';
    } catch {
      return false;
    }
  });

  // Attach/update audio elements - NO cleanup on re-render to prevent audio breaks
  useEffect(() => {
    const audioElements = audioElementsRef.current;

    // Create/update audio elements for each remote participant with audio
    for (const participant of remoteWithAudio) {
      const { id, audioTrack } = participant;
      if (!audioTrack) continue;

      let audioEl = audioElements.get(id);

      // Create audio element if it doesn't exist
      if (!audioEl) {
        audioEl = new Audio();
        audioEl.autoplay = true;
        // Not muted - we want to hear remote audio!
        audioEl.muted = false;
        audioElements.set(id, audioEl);
      }

      // Update volume (per-participant override takes precedence)
      audioEl.volume = getParticipantVolume ? getParticipantVolume(id) : volume;

      // Check if we need to attach a new track
      const currentStream = audioEl.srcObject as MediaStream | null;
      const currentTrack = currentStream?.getAudioTracks()[0];

      if (currentTrack?.id !== audioTrack.id) {
        // Attach the new track
        const stream = new MediaStream([audioTrack]);
        audioEl.srcObject = stream;

        // Handle autoplay restrictions
        audioEl.play().catch(() => {
          // Autoplay was blocked - user interaction required
          // This is expected on some browsers until user interacts with page
        });
      }
    }

    // Clean up audio elements ONLY for participants who left or stopped audio
    // Do NOT clean up all elements on every render - that causes audio breaks
    const activeIds = new Set(remoteWithAudio.map((p) => p.id));
    for (const [id, audioEl] of audioElements.entries()) {
      if (!activeIds.has(id)) {
        audioEl.srcObject = null;
        audioEl.pause();
        audioElements.delete(id);
      }
    }
    // No cleanup return here - we only clean departed participants above
  }, [remoteWithAudio, volume, getParticipantVolume]);

  // Unmount-only cleanup for mic audio
  useEffect(() => {
    const audioElements = audioElementsRef.current;
    return () => {
      for (const audioEl of audioElements.values()) {
        audioEl.srcObject = null;
        audioEl.pause();
      }
      audioElements.clear();
    };
  }, []);

  // Handle track ended events
  useEffect(() => {
    const handlers = new Map<string, { track: MediaStreamTrack; handler: () => void }>();

    for (const participant of remoteWithAudio) {
      const { id, audioTrack } = participant;
      if (!audioTrack) continue;

      const handleEnded = () => {
        const audioEl = audioElementsRef.current.get(id);
        if (audioEl) {
          audioEl.srcObject = null;
          audioEl.pause();
          audioElementsRef.current.delete(id);
        }
      };

      try {
        audioTrack.addEventListener('ended', handleEnded);
        handlers.set(id, { track: audioTrack, handler: handleEnded });
      } catch {
        // Track may be invalid
      }
    }

    return () => {
      for (const { track, handler } of handlers.values()) {
        try {
          track.removeEventListener('ended', handler);
        } catch {
          // Track may have been disposed
        }
      }
    };
  }, [remoteWithAudio]);

  // Handle screen share audio tracks - NO cleanup on re-render
  useEffect(() => {
    const audioElements = screenShareAudioRef.current;

    for (const participant of remoteWithScreenShareAudio) {
      const { id, screenShareAudioTrack } = participant;
      if (!screenShareAudioTrack) continue;

      const ssKey = `ss-${id}`;
      let audioEl = audioElements.get(ssKey);

      if (!audioEl) {
        audioEl = new Audio();
        audioEl.autoplay = true;
        audioEl.muted = false;
        audioElements.set(ssKey, audioEl);
      }

      // Per-participant override uses participant id (not ss- key)
      audioEl.volume = getParticipantVolume ? getParticipantVolume(id) : volume;

      const currentStream = audioEl.srcObject as MediaStream | null;
      const currentTrack = currentStream?.getAudioTracks()[0];

      if (currentTrack?.id !== screenShareAudioTrack.id) {
        const stream = new MediaStream([screenShareAudioTrack]);
        audioEl.srcObject = stream;
        audioEl.play().catch(() => {
          // Autoplay was blocked - user interaction required
        });
      }
    }

    // Clean up ONLY departed participants
    const activeIds = new Set(remoteWithScreenShareAudio.map((p) => `ss-${p.id}`));
    for (const [key, audioEl] of audioElements.entries()) {
      if (!activeIds.has(key)) {
        audioEl.srcObject = null;
        audioEl.pause();
        audioElements.delete(key);
      }
    }
  }, [remoteWithScreenShareAudio, volume, getParticipantVolume]);

  // Unmount-only cleanup for screen share audio
  useEffect(() => {
    const audioElements = screenShareAudioRef.current;
    return () => {
      for (const audioEl of audioElements.values()) {
        audioEl.srcObject = null;
        audioEl.pause();
      }
      audioElements.clear();
    };
  }, []);

  // This component renders nothing visible - audio is played through Audio elements
  return null;
}

AudioRenderer.displayName = 'AudioRenderer';
