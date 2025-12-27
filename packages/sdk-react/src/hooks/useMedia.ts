/**
 * useMedia hook - Control local media (video, audio, screen share)
 */

import { useState, useCallback, useEffect } from 'react';
import { useChalk } from '../context.tsx';
import type { ScreenShareOptions } from '@chalk/core';

export interface UseMediaResult {
  isVideoEnabled: boolean;
  isAudioEnabled: boolean;
  isScreenSharing: boolean;
  toggleVideo: () => Promise<void>;
  toggleAudio: () => Promise<void>;
  startScreenShare: (options?: ScreenShareOptions) => Promise<void>;
  stopScreenShare: () => void;
}

export function useMedia(): UseMediaResult {
  const { room } = useChalk();
  const [isVideoEnabled, setIsVideoEnabled] = useState(false);
  const [isAudioEnabled, setIsAudioEnabled] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);

  // Sync state with room
  useEffect(() => {
    if (room?.localParticipant) {
      setIsVideoEnabled(room.localParticipant.videoEnabled);
      setIsAudioEnabled(room.localParticipant.audioEnabled);
      setIsScreenSharing(room.localParticipant.isScreenSharing);
    }
  }, [room]);

  const toggleVideo = useCallback(async () => {
    if (!room) return;
    const enabled = await room.toggleVideo();
    setIsVideoEnabled(enabled);
  }, [room]);

  const toggleAudio = useCallback(async () => {
    if (!room) return;
    const enabled = await room.toggleAudio();
    setIsAudioEnabled(enabled);
  }, [room]);

  const startScreenShare = useCallback(
    async (options?: ScreenShareOptions) => {
      if (!room) return;
      const success = await room.startScreenShare(options);
      if (success) {
        setIsScreenSharing(true);
      }
    },
    [room]
  );

  const stopScreenShare = useCallback(() => {
    if (!room) return;
    room.stopScreenShare();
    setIsScreenSharing(false);
  }, [room]);

  return {
    isVideoEnabled,
    isAudioEnabled,
    isScreenSharing,
    toggleVideo,
    toggleAudio,
    startScreenShare,
    stopScreenShare,
  };
}
