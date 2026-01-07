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
  isLocal?: boolean;
}

export interface AudioRendererProps {
  /** All participants - will filter to remote participants with audio tracks */
  participants: AudioParticipant[];
  /** Volume level 0-1 (default: 1) */
  volume?: number;
}

/**
 * Renders audio for all remote participants.
 * Must be included once in your room to hear other participants.
 */
export function AudioRenderer({ participants, volume = 1 }: AudioRendererProps) {
  // Map of participant ID -> audio element
  const audioElementsRef = useRef<Map<string, HTMLAudioElement>>(new Map());

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

      // Update volume
      audioEl.volume = volume;

      // Check if we need to attach a new track
      const currentStream = audioEl.srcObject as MediaStream | null;
      const currentTrack = currentStream?.getAudioTracks()[0];

      if (currentTrack?.id !== audioTrack.id) {
        // Attach the new track
        const stream = new MediaStream([audioTrack]);
        audioEl.srcObject = stream;

        // Handle autoplay restrictions
        audioEl.play().catch((err) => {
          // Autoplay was blocked - user interaction required
          // This is expected on some browsers until user interacts with page
          if (err.name !== 'AbortError') {
            console.warn(
              `[AudioRenderer] Autoplay blocked for participant ${id}. User interaction may be required.`
            );
          }
        });
      }
    }

    // Clean up audio elements for participants who left or stopped audio
    const activeIds = new Set(remoteWithAudio.map((p) => p.id));
    for (const [id, audioEl] of audioElements.entries()) {
      if (!activeIds.has(id)) {
        audioEl.srcObject = null;
        audioEl.pause();
        audioElements.delete(id);
      }
    }

    // Cleanup on unmount
    return () => {
      for (const audioEl of audioElements.values()) {
        audioEl.srcObject = null;
        audioEl.pause();
      }
      audioElements.clear();
    };
  }, [remoteWithAudio, volume]);

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

  // This component renders nothing visible - audio is played through Audio elements
  return null;
}

AudioRenderer.displayName = 'AudioRenderer';
