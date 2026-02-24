/**
 * AudioRenderer - Renders hidden audio elements for remote participants
 *
 * WebRTC audio tracks must be attached to HTML audio elements to be heard.
 * This component creates and manages audio elements for all remote participants.
 *
 * Usage: Place once in your room component, passing all remote participants.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
  /** Selected audio output device id for routing playback via setSinkId (when supported). */
  audioOutputDeviceId?: string;
  /** Per-participant volume override (0-1). Takes precedence over volume prop. */
  getParticipantVolume?: (participantId: string) => number;
}

/**
 * Renders audio for all remote participants.
 * Must be included once in your room to hear other participants.
 */
type SinkAwareAudioElement = HTMLAudioElement & {
  setSinkId?: (sinkId: string) => Promise<void>;
  sinkId?: string;
};

export function AudioRenderer({
  participants,
  volume = 1,
  audioOutputDeviceId,
  getParticipantVolume,
}: AudioRendererProps) {
  // Map of participant ID -> audio element (mic audio)
  const audioElementsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  // Map of participant ID -> audio element (screen share audio)
  const screenShareAudioRef = useRef<Map<string, HTMLAudioElement>>(new Map());

  // When autoplay is blocked (common on iOS/Safari until user gesture), we need to
  // retry play() on the next interaction. Without this, audio can stay silent.
  const pendingAutoplayRetryRef = useRef<Set<HTMLMediaElement>>(new Set());
  const [needsAutoplayUnlock, setNeedsAutoplayUnlock] = useState(false);

  const markAutoplayBlocked = (el: HTMLMediaElement) => {
    pendingAutoplayRetryRef.current.add(el);
    // Setting true repeatedly is fine; avoids stale-closure edge cases.
    setNeedsAutoplayUnlock(true);
  };

  const clearAutoplayRetryForElement = (el: HTMLMediaElement) => {
    pendingAutoplayRetryRef.current.delete(el);
    if (pendingAutoplayRetryRef.current.size === 0) setNeedsAutoplayUnlock(false);
  };

  const applyAudioOutputDevice = useCallback((audioEl: HTMLAudioElement) => {
    if (!audioOutputDeviceId) return;
    const sinkAware = audioEl as SinkAwareAudioElement;
    if (typeof sinkAware.setSinkId !== 'function') return;
    if (sinkAware.sinkId === audioOutputDeviceId) return;
    void sinkAware.setSinkId(audioOutputDeviceId).catch(() => {
      // Ignore unsupported/failed sink routing and continue with default output.
    });
  }, [audioOutputDeviceId]);

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

  const unlockEvents = useMemo(
    () => ['pointerdown', 'touchend', 'click', 'keydown'] as const,
    []
  );

  useEffect(() => {
    if (!needsAutoplayUnlock) return;
    if (typeof window === 'undefined') return;

    let inFlight = false;

    const tryUnlock = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const els = Array.from(pendingAutoplayRetryRef.current);
        if (els.length === 0) {
          setNeedsAutoplayUnlock(false);
          return;
        }

        // Retry play() for any elements that previously failed due to autoplay.
        const results = await Promise.allSettled(els.map((el) => el.play()));
        pendingAutoplayRetryRef.current.clear();
        for (const [i, r] of results.entries()) {
          const el = els[i];
          if (!el) continue;
          if (r.status === 'rejected') pendingAutoplayRetryRef.current.add(el);
        }

        if (pendingAutoplayRetryRef.current.size === 0) {
          setNeedsAutoplayUnlock(false);
        }
      } finally {
        inFlight = false;
      }
    };

    const handler = () => {
      void tryUnlock();
    };

    const opts: AddEventListenerOptions = { capture: true, passive: true };
    for (const ev of unlockEvents) {
      window.addEventListener(ev, handler, opts);
    }

    // If the browser already considers the page activated, try immediately.
    try {
      const ua = (navigator as any)?.userActivation;
      if (ua?.isActive || ua?.hasBeenActive) void tryUnlock();
    } catch {
      // ignore
    }

    return () => {
      for (const ev of unlockEvents) {
        window.removeEventListener(ev, handler, opts);
      }
    };
  }, [needsAutoplayUnlock, unlockEvents]);

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

      applyAudioOutputDevice(audioEl);

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
          // Autoplay was blocked - retry on next user interaction.
          markAutoplayBlocked(audioEl!);
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
        clearAutoplayRetryForElement(audioEl);
        audioElements.delete(id);
      }
    }
    // No cleanup return here - we only clean departed participants above
  }, [remoteWithAudio, volume, audioOutputDeviceId, getParticipantVolume, applyAudioOutputDevice]);

  // Unmount-only cleanup for mic audio
  useEffect(() => {
    const audioElements = audioElementsRef.current;
    return () => {
      for (const audioEl of audioElements.values()) {
        audioEl.srcObject = null;
        audioEl.pause();
        clearAutoplayRetryForElement(audioEl);
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
          clearAutoplayRetryForElement(audioEl);
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

      applyAudioOutputDevice(audioEl);

      // Per-participant override uses participant id (not ss- key)
      audioEl.volume = getParticipantVolume ? getParticipantVolume(id) : volume;

      const currentStream = audioEl.srcObject as MediaStream | null;
      const currentTrack = currentStream?.getAudioTracks()[0];

      if (currentTrack?.id !== screenShareAudioTrack.id) {
        const stream = new MediaStream([screenShareAudioTrack]);
        audioEl.srcObject = stream;
        audioEl.play().catch(() => {
          // Autoplay was blocked - retry on next user interaction.
          markAutoplayBlocked(audioEl!);
        });
      }
    }

    // Clean up ONLY departed participants
    const activeIds = new Set(remoteWithScreenShareAudio.map((p) => `ss-${p.id}`));
    for (const [key, audioEl] of audioElements.entries()) {
      if (!activeIds.has(key)) {
        audioEl.srcObject = null;
        audioEl.pause();
        clearAutoplayRetryForElement(audioEl);
        audioElements.delete(key);
      }
    }
  }, [remoteWithScreenShareAudio, volume, audioOutputDeviceId, getParticipantVolume, applyAudioOutputDevice]);

  // Unmount-only cleanup for screen share audio
  useEffect(() => {
    const audioElements = screenShareAudioRef.current;
    return () => {
      for (const audioEl of audioElements.values()) {
        audioEl.srcObject = null;
        audioEl.pause();
        clearAutoplayRetryForElement(audioEl);
      }
      audioElements.clear();
    };
  }, []);

  // This component renders nothing visible - audio is played through Audio elements
  return null;
}

AudioRenderer.displayName = 'AudioRenderer';
