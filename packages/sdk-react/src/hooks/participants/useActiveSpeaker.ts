/**
 * useActiveSpeaker - Track the current active speaker
 */

import type { Participant, ParticipantState } from "@q9labs/chalk-core";
import { useEffect, useMemo, useState } from "react";
import { useSession } from "../../context/chalk-provider";

export interface UseActiveSpeakerReturn {
  /** Current active speaker (null if none) */
  activeSpeaker: Participant | null;
  /** Whether local user is speaking */
  isLocalSpeaking: boolean;
  /** Active speaker's ID */
  activeSpeakerId: string | null;
}

/**
 * Hook to track the current active speaker
 *
 * @example
 * ```tsx
 * function SpeakerIndicator() {
 *   const { activeSpeaker, isLocalSpeaking } = useActiveSpeaker();
 *
 *   if (isLocalSpeaking) {
 *     return <span className="badge">You are speaking</span>;
 *   }
 *
 *   if (activeSpeaker) {
 *     return <span className="badge">{activeSpeaker.displayName} is speaking</span>;
 *   }
 *
 *   return null;
 * }
 * ```
 */
export function useActiveSpeaker(): UseActiveSpeakerReturn {
  const session = useSession();
  const { participants: manager } = session;

  const [state, setState] = useState<ParticipantState>(() => manager.getState());

  useEffect(() => {
    return manager.subscribe(setState);
  }, [manager]);

  return useMemo((): UseActiveSpeakerReturn => {
    const activeSpeaker = state.activeSpeaker;
    return {
      activeSpeaker,
      isLocalSpeaking: activeSpeaker?.isLocal ?? false,
      activeSpeakerId: activeSpeaker?.id ?? null,
    };
  }, [state.activeSpeaker]);
}
