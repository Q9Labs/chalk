import { createContext, useContext, useMemo, useState, type PropsWithChildren } from "react";
import type React from "react";

export interface ParticipantVolumeState {
  readonly volumes: ReadonlyMap<string, number>;
  readonly setVolume: (participantId: string, volume: number) => void;
}

const ParticipantVolumeContext = createContext<ParticipantVolumeState | null>(null);

export function ParticipantVolumeProvider({ children }: PropsWithChildren): React.JSX.Element {
  const [volumes, setVolumes] = useState<ReadonlyMap<string, number>>(new Map());
  const value = useMemo<ParticipantVolumeState>(
    () => ({
      volumes,
      setVolume: (participantId, volume) => {
        setVolumes((current) => {
          const next = new Map(current);
          if (volume === 100) next.delete(participantId);
          else next.set(participantId, volume);
          return next;
        });
      },
    }),
    [volumes],
  );

  return <ParticipantVolumeContext.Provider value={value}>{children}</ParticipantVolumeContext.Provider>;
}

export function useParticipantVolumeContext(): ParticipantVolumeState | null {
  return useContext(ParticipantVolumeContext);
}
