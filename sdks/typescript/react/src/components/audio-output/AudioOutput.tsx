/**
 * AudioOutput - Renders hidden audio elements for remote participants
 *
 * WebRTC audio tracks must be attached to HTML audio elements to be heard.
 * This component creates and manages audio elements for all remote participants.
 *
 * Usage: Place once in your space component, passing all remote participants.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useMedia, useParticipants, useSelf, useSpaceClient } from "../../bindings/hooks";
import { toAudioParticipants } from "../../selectors/space-selectors";
import { useParticipantVolumeContext } from "../participants-panel/participant-volume-context";

export interface AudioParticipant {
  id: string;
  audioTrack?: MediaStreamTrack | null;
  screenShareAudioTrack?: MediaStreamTrack | null;
  isLocal?: boolean;
}

export interface AudioOutputProps {
  /** All participants - will filter to remote participants with audio tracks */
  participants?: AudioParticipant[];
  /** Volume level 0-1 (default: 1) */
  volume?: number;
  /** Selected audio output device id for routing playback via setSinkId (when supported). */
  audioOutputDeviceId?: string;
  /** Per-participant volume override (0-1). Takes precedence over volume prop. */
  getParticipantVolume?: (participantId: string) => number;
}

/**
 * Renders audio for all remote participants.
 * Must be included once in your space to hear other participants.
 */
type SinkAwareAudioElement = HTMLAudioElement & {
  setSinkId?: (sinkId: string) => Promise<void>;
  sinkId?: string;
};

export function AudioOutput({ participants, volume = 1, audioOutputDeviceId, getParticipantVolume }: AudioOutputProps) {
  const client = useSpaceClient();
  const media = useMedia();
  const self = useSelf();
  const participantState = useParticipants();
  const volumeContext = useParticipantVolumeContext();
  const contextParticipants = useMemo(() => toAudioParticipants(media.remote), [media.remote]);
  const effectiveParticipants = useMemo(() => {
    const stateById = new Map(participantState.roster.map((participant) => [participant.participantId, participant.media]));
    const identityId = self.identityId ?? participantState.roster.find((participant) => participant.participantId === self.participantId)?.identityId;
    const ownDevices = new Set(participantState.roster.filter((participant) => identityId && participant.identityId === identityId).map((participant) => participant.participantId));
    return (participants ?? contextParticipants)
      .filter((participant) => !ownDevices.has(participant.id))
      .map((participant) => {
        const state = stateById.get(participant.id);
        return {
          ...participant,
          audioTrack: state?.microphone === "active" ? participant.audioTrack : null,
          screenShareAudioTrack: state?.screenShare === "active" ? participant.screenShareAudioTrack : null,
        };
      });
  }, [participants, contextParticipants, participantState.roster, self.participantId, self.identityId]);
  const effectiveAudioOutputDeviceId = audioOutputDeviceId ?? media.selection.speaker ?? undefined;
  const effectiveGetParticipantVolume = getParticipantVolume ?? ((participantId: string) => (volumeContext?.volumes.get(participantId) ?? 100) / 100);
  // Map of participant ID -> audio element (mic audio)
  const audioElementsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  // Map of participant ID -> audio element (screen share audio)
  const screenShareAudioRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const observationsRef = useRef(new Map<HTMLMediaElement, { played(result: unknown): void; detach(): void }>());
  const detachObservation = (element: HTMLMediaElement) => {
    observationsRef.current.get(element)?.detach();
    observationsRef.current.delete(element);
  };

  const applyAudioOutputDevice = useCallback(
    (audioEl: HTMLAudioElement) => {
      if (!effectiveAudioOutputDeviceId) return;
      const sinkAware = audioEl as SinkAwareAudioElement;
      if (typeof sinkAware.setSinkId !== "function") return;
      if (sinkAware.sinkId === effectiveAudioOutputDeviceId) return;
      void sinkAware.setSinkId(effectiveAudioOutputDeviceId).catch(() => {
        // Ignore unsupported/failed sink routing and continue with default output.
      });
    },
    [effectiveAudioOutputDeviceId],
  );

  // Filter to remote participants with valid audio tracks. Memoized so the
  // attach/volume effects below do not tear down and rebuild on every render.
  const remoteWithAudio = useMemo(
    () =>
      effectiveParticipants.filter((p) => {
        if (p.isLocal) return false;
        if (!p.audioTrack) return false;
        try {
          return p.audioTrack.readyState === "live";
        } catch {
          // Track may have been disposed
          return false;
        }
      }),
    [effectiveParticipants],
  );

  // Filter to remote participants with valid screen share audio tracks
  const remoteWithScreenShareAudio = useMemo(
    () =>
      effectiveParticipants.filter((p) => {
        if (p.isLocal) return false;
        if (!p.screenShareAudioTrack) return false;
        try {
          return p.screenShareAudioTrack.readyState === "live";
        } catch {
          // Track may have been disposed
          return false;
        }
      }),
    [effectiveParticipants],
  );

  const unlockEvents = useMemo(() => ["touchend", "click", "keydown"] as const, []);

  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- Own autoplay gesture listeners until playback is unblocked.
  useEffect(() => {
    if (!media.audioPlayback.blocked || typeof window === "undefined") return;
    const resume = () => {
      void client.media.resumeAudioPlayback().catch(() => undefined);
    };
    const opts: AddEventListenerOptions = { capture: true, passive: true };
    for (const event of unlockEvents) window.addEventListener(event, resume, opts);
    try {
      const activation = navigator?.userActivation;
      if (activation?.isActive || activation?.hasBeenActive) resume();
    } catch {
      // A browser without userActivation still receives the gesture listeners above.
    }
    return () => {
      for (const event of unlockEvents) window.removeEventListener(event, resume, opts);
    };
  }, [client, media.audioPlayback.blocked, unlockEvents]);

  // Attach/update audio elements - NO cleanup on re-render to prevent audio breaks
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- Own existing audio elements, autoplay listeners, and media-track cleanup.
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
        audioEl.dataset.participantId = id;
        audioEl.autoplay = true;
        // Not muted - we want to hear remote audio!
        audioEl.muted = false;
        audioElements.set(id, audioEl);
      }

      applyAudioOutputDevice(audioEl);

      // Update volume (per-participant override multiplied by global volume)
      const baseVolume = effectiveGetParticipantVolume(id);
      audioEl.volume = Math.max(0, Math.min(1, baseVolume * volume));

      // Check if we need to attach a new track
      const currentStream = audioEl.srcObject as MediaStream | null;
      const currentTrack = currentStream?.getAudioTracks()[0];

      if (currentTrack !== audioTrack) {
        detachObservation(audioEl);
        // Attach the new track
        const stream = new MediaStream([audioTrack]);
        audioEl.srcObject = stream;
        const observation = client.media.observeAudioElement(audioTrack, audioEl);
        observationsRef.current.set(audioEl, observation);

        // Handle autoplay restrictions
        audioEl
          .play()
          .then(() => {
            observation.played(undefined);
          })
          .catch((cause: unknown) => {
            observation.played(cause);
            // The client records a real NotAllowedError as blocked playback; other play failures stay out of that state.
          });
      }
    }

    // Clean up audio elements ONLY for participants who left or stopped audio
    // Do NOT clean up all elements on every render - that causes audio breaks
    const activeIds = new Set(remoteWithAudio.map((p) => p.id));
    for (const [id, audioEl] of audioElements.entries()) {
      if (!activeIds.has(id)) {
        detachObservation(audioEl);
        audioEl.srcObject = null;
        audioEl.pause();
        audioElements.delete(id);
      }
    }
    // No cleanup return here - we only clean departed participants above
  }, [client, remoteWithAudio, volume, effectiveAudioOutputDeviceId, effectiveGetParticipantVolume, applyAudioOutputDevice]);

  // Unmount-only cleanup for mic audio
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- Own existing audio elements, autoplay listeners, and media-track cleanup.
  useEffect(() => {
    const audioElements = audioElementsRef.current;
    return () => {
      for (const audioEl of audioElements.values()) {
        detachObservation(audioEl);
        audioEl.srcObject = null;
        audioEl.pause();
      }
      audioElements.clear();
    };
  }, []);

  // Handle track ended events
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- Own existing audio elements, autoplay listeners, and media-track cleanup.
  useEffect(() => {
    const handlers = new Map<string, { track: MediaStreamTrack; handler: () => void }>();

    for (const participant of remoteWithAudio) {
      const { id, audioTrack } = participant;
      if (!audioTrack) continue;

      const handleEnded = () => {
        const audioEl = audioElementsRef.current.get(id);
        if (audioEl) {
          detachObservation(audioEl);
          audioEl.srcObject = null;
          audioEl.pause();
          audioElementsRef.current.delete(id);
        }
      };

      try {
        audioTrack.addEventListener("ended", handleEnded);
        handlers.set(id, { track: audioTrack, handler: handleEnded });
      } catch {
        // Track may be invalid
      }
    }

    return () => {
      for (const { track, handler } of handlers.values()) {
        try {
          track.removeEventListener("ended", handler);
        } catch {
          // Track may have been disposed
        }
      }
    };
  }, [remoteWithAudio]);

  // Handle screen share audio tracks - NO cleanup on re-render
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- Own existing audio elements, autoplay listeners, and media-track cleanup.
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

      // Update volume (per-participant override multiplied by global volume)
      const baseVolume = effectiveGetParticipantVolume(id);
      audioEl.volume = Math.max(0, Math.min(1, baseVolume * volume));

      const currentStream = audioEl.srcObject as MediaStream | null;
      const currentTrack = currentStream?.getAudioTracks()[0];

      if (currentTrack !== screenShareAudioTrack) {
        detachObservation(audioEl);
        const stream = new MediaStream([screenShareAudioTrack]);
        audioEl.srcObject = stream;
        const observation = client.media.observeAudioElement(screenShareAudioTrack, audioEl);
        observationsRef.current.set(audioEl, observation);
        audioEl
          .play()
          .then(() => {
            observation.played(undefined);
          })
          .catch((cause: unknown) => {
            observation.played(cause);
            // The client records a real NotAllowedError as blocked playback; other play failures stay out of that state.
          });
      }
    }

    // Clean up ONLY departed participants
    const activeIds = new Set(remoteWithScreenShareAudio.map((p) => `ss-${p.id}`));
    for (const [key, audioEl] of audioElements.entries()) {
      if (!activeIds.has(key)) {
        detachObservation(audioEl);
        audioEl.srcObject = null;
        audioEl.pause();
        audioElements.delete(key);
      }
    }
  }, [client, remoteWithScreenShareAudio, volume, effectiveAudioOutputDeviceId, effectiveGetParticipantVolume, applyAudioOutputDevice]);

  // Unmount-only cleanup for screen share audio
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- Own existing audio elements, autoplay listeners, and media-track cleanup.
  useEffect(() => {
    const audioElements = screenShareAudioRef.current;
    return () => {
      for (const audioEl of audioElements.values()) {
        detachObservation(audioEl);
        audioEl.srcObject = null;
        audioEl.pause();
      }
      audioElements.clear();
    };
  }, []);

  return null;
}

AudioOutput.displayName = "AudioOutput";
