/**
 * useParticipants hook - Access participant list and local participant
 */

import { useState, useEffect, useCallback } from 'react';
import { useChalk } from '../context.tsx';
import type { Participant } from '@chalk/core';

export interface UseParticipantsResult {
  participants: Participant[];
  localParticipant: Participant | null;
  activeSpeaker: Participant | null;
  participantCount: number;
}

export function useParticipants(): UseParticipantsResult {
  const { room } = useChalk();
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [activeSpeaker, setActiveSpeaker] = useState<Participant | null>(null);

  const updateParticipants = useCallback(() => {
    if (room) {
      setParticipants(Array.from(room.participants.values()));
      setActiveSpeaker(room.activeSpeaker);
    } else {
      setParticipants([]);
      setActiveSpeaker(null);
    }
  }, [room]);

  useEffect(() => {
    if (!room) return;

    updateParticipants();

    const unsubJoined = room.on('participant-joined', updateParticipants);
    const unsubLeft = room.on('participant-left', updateParticipants);
    const unsubUpdated = room.on('participant-updated', updateParticipants);
    const unsubSpeaker = room.on('active-speaker-changed', (speaker) => {
      setActiveSpeaker(speaker);
    });

    return () => {
      unsubJoined();
      unsubLeft();
      unsubUpdated();
      unsubSpeaker();
    };
  }, [room, updateParticipants]);

  const localParticipant = room?.localParticipant ?? null;

  return {
    participants,
    localParticipant,
    activeSpeaker,
    participantCount: participants.length,
  };
}
