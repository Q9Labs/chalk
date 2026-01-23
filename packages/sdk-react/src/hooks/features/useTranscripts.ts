/**
 * useTranscripts - Real-time transcription from RealtimeKit AI
 *
 * Requires transcription_enabled in the RealtimeKit preset configuration.
 */

import type { Transcript } from "@q9labs/chalk-core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "../../context/chalk-provider";

export interface UseTranscriptsReturn {
  /** All transcripts from the session */
  transcripts: Transcript[];
  /** Whether transcription is available/enabled */
  isAvailable: boolean;
  /** Clear all transcripts (local only) */
  clearTranscripts: () => void;
  /** Export transcripts to various formats */
  exportTranscripts: (format: "txt" | "srt" | "vtt") => string;
  /** Search transcripts by text or speaker */
  searchTranscripts: (query: string) => Transcript[];
}

/**
 * Hook for real-time meeting transcription
 *
 * @example
 * ```tsx
 * function TranscriptPanel() {
 *   const { transcripts, isAvailable, exportTranscripts } = useTranscripts();
 *
 *   if (!isAvailable) {
 *     return <p>Transcription not enabled</p>;
 *   }
 *
 *   return (
 *     <div>
 *       {transcripts.map((t) => (
 *         <div key={t.id}>
 *           <strong>{t.speakerName}:</strong> {t.text}
 *         </div>
 *       ))}
 *       <button onClick={() => console.log(exportTranscripts('txt'))}>
 *         Export
 *       </button>
 *     </div>
 *   );
 * }
 * ```
 */
export function useTranscripts(): UseTranscriptsReturn {
  const session = useSession();
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [isAvailable, setIsAvailable] = useState(false);

  // Subscribe to transcript events from the room
  useEffect(() => {
    const room = session.chalkClient.room;
    console.log("[useTranscripts] Setting up transcript subscription", { hasRoom: !!room });

    if (!room) {
      console.warn("[useTranscripts] No room available");
      return;
    }

    // Load existing transcripts
    const existing = room.transcripts;
    console.log("[useTranscripts] Checking existing transcripts", { count: existing.length });
    if (existing.length > 0) {
      console.log("[useTranscripts] Loading existing transcripts", { transcripts: existing });
      setTranscripts(existing);
      setIsAvailable(true);
    }

    // Listen for new transcripts
    const handleTranscript = (transcript: Transcript) => {
      console.log("[useTranscripts] Received transcript event", {
        id: transcript.id,
        speaker: transcript.speakerName,
        text: transcript.text?.slice(0, 100),
        isInterim: transcript.isInterim,
      });
      setIsAvailable(true);
      setTranscripts((prev) => [...prev, transcript]);
    };

    console.log("[useTranscripts] Subscribing to room transcript event");
    room.on("transcript", handleTranscript);

    return () => {
      console.log("[useTranscripts] Unsubscribing from room transcript event");
      room.off("transcript", handleTranscript);
    };
  }, [session]);

  const clearTranscripts = useCallback(() => {
    setTranscripts([]);
  }, []);

  const exportTranscripts = useCallback(
    (format: "txt" | "srt" | "vtt"): string => {
      switch (format) {
        case "txt":
          return transcripts
            .map(
              (t) =>
                `[${t.timestamp.toLocaleTimeString()}] ${t.speakerName}: ${t.text}`
            )
            .join("\n");

        case "srt":
          return transcripts
            .map((t, i) => {
              const start = formatTimestamp(t.timestamp, "srt");
              const end = formatTimestamp(
                new Date(t.timestamp.getTime() + 3000),
                "srt"
              );
              return `${i + 1}\n${start} --> ${end}\n${t.speakerName}: ${t.text}\n`;
            })
            .join("\n");

        case "vtt": {
          const header = "WEBVTT\n\n";
          const content = transcripts
            .map((t) => {
              const start = formatTimestamp(t.timestamp, "vtt");
              const end = formatTimestamp(
                new Date(t.timestamp.getTime() + 3000),
                "vtt"
              );
              return `${start} --> ${end}\n<v ${t.speakerName}>${t.text}\n`;
            })
            .join("\n");
          return header + content;
        }

        default:
          return "";
      }
    },
    [transcripts]
  );

  const searchTranscripts = useCallback(
    (query: string): Transcript[] => {
      if (!query.trim()) return transcripts;
      const lowerQuery = query.toLowerCase();
      return transcripts.filter(
        (t) =>
          t.text.toLowerCase().includes(lowerQuery) ||
          t.speakerName.toLowerCase().includes(lowerQuery)
      );
    },
    [transcripts]
  );

  return useMemo(
    (): UseTranscriptsReturn => ({
      transcripts,
      isAvailable,
      clearTranscripts,
      exportTranscripts,
      searchTranscripts,
    }),
    [transcripts, isAvailable, clearTranscripts, exportTranscripts, searchTranscripts]
  );
}

// Helper function
function formatTimestamp(date: Date, format: "srt" | "vtt"): string {
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const seconds = date.getSeconds().toString().padStart(2, "0");
  const ms = date.getMilliseconds().toString().padStart(3, "0");

  if (format === "srt") {
    return `${hours}:${minutes}:${seconds},${ms}`;
  }
  return `${hours}:${minutes}:${seconds}.${ms}`;
}
