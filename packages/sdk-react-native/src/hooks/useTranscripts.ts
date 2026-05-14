import type { Transcript } from "@q9labs/chalk-core";
import { useEffect, useMemo, useState } from "react";
import { useSession } from "../context/chalk-native-provider";
import { useConnection } from "./useConnection";

export interface UseTranscriptsReturn {
  transcripts: Transcript[];
  isAvailable: boolean;
  clearTranscripts: () => void;
}

export function useTranscripts(): UseTranscriptsReturn {
  const session = useSession();
  const { isConnected } = useConnection();
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [isAvailable, setIsAvailable] = useState(false);

  useEffect(() => {
    const room = session.room.getRoom();
    if (!room || !isConnected) {
      return;
    }

    const existing = room.transcripts;
    if (existing.length > 0) {
      setTranscripts(existing);
      setIsAvailable(true);
    }

    const handleTranscript = (transcript: Transcript) => {
      setIsAvailable(true);
      setTranscripts((previous) => [...previous, transcript]);
    };

    room.on("transcript", handleTranscript);
    return () => {
      room.off("transcript", handleTranscript);
    };
  }, [session, isConnected]);

  return useMemo(
    () => ({
      transcripts,
      isAvailable,
      clearTranscripts: () => {
        setTranscripts([]);
      },
    }),
    [transcripts, isAvailable],
  );
}
