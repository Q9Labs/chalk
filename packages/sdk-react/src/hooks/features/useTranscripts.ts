/**
 * useTranscripts - Real-time transcription from RealtimeKit AI
 *
 * Requires transcription_enabled in the RealtimeKit preset configuration.
 */

import type { Transcript } from "@q9labs/chalk-core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "../../context/chalk-provider";
import { useRoom } from "../room/useRoom";

export interface UseTranscriptsReturn {
  /** All transcripts from the session */
  transcripts: Transcript[];
  /** Whether transcription is available/enabled */
  isAvailable: boolean;
  /** Clear all transcripts (local only) */
  clearTranscripts: () => void;
  /** Export transcripts to various formats */
  exportTranscripts: (format: "txt" | "srt" | "vtt" | "json") => string;
  /** Search transcripts by text or speaker */
  searchTranscripts: (query: string) => Transcript[];
  /** Copy all transcripts to clipboard as plain text */
  copyToClipboard: () => Promise<void>;
  /** Download transcript file */
  downloadTranscript: (format: "txt" | "srt" | "vtt" | "json", roomId?: string) => void;
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
  const { isConnected } = useRoom();
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [isAvailable, setIsAvailable] = useState(false);

  // Subscribe to transcript events from the room
  // Re-run when connection status changes (room becomes available after join)
  useEffect(() => {
    const room = session.room.getRoom();

    if (!room || !isConnected) {
      return;
    }

    // Load existing transcripts
    const existing = room.transcripts;
    if (existing.length > 0) {
      setTranscripts(existing);
      setIsAvailable(true);
    }

    // Listen for new transcripts
    const handleTranscript = (transcript: Transcript) => {
      setIsAvailable(true);
      setTranscripts((prev) => [...prev, transcript]);
    };

    room.on("transcript", handleTranscript);

    return () => {
      room.off("transcript", handleTranscript);
    };
  }, [session, isConnected]);

  const clearTranscripts = useCallback(() => {
    setTranscripts([]);
  }, []);

  const exportTranscripts = useCallback(
    (format: "txt" | "srt" | "vtt" | "json"): string => {
      switch (format) {
        case "txt":
          return transcripts.map((t) => `[${t.timestamp.toLocaleTimeString()}] ${t.speakerName}: ${t.text}`).join("\n");

        case "srt":
          return transcripts
            .map((t, i) => {
              const start = formatTimestamp(t.timestamp, "srt");
              const end = formatTimestamp(new Date(t.timestamp.getTime() + 3000), "srt");
              return `${i + 1}\n${start} --> ${end}\n${t.speakerName}: ${t.text}\n`;
            })
            .join("\n");

        case "vtt": {
          const header = "WEBVTT\n\n";
          const content = transcripts
            .map((t) => {
              const start = formatTimestamp(t.timestamp, "vtt");
              const end = formatTimestamp(new Date(t.timestamp.getTime() + 3000), "vtt");
              return `${start} --> ${end}\n<v ${t.speakerName}>${t.text}\n`;
            })
            .join("\n");
          return header + content;
        }

        case "json":
          return JSON.stringify(
            transcripts.map((t) => ({
              id: t.id,
              participantId: t.participantId,
              speakerName: t.speakerName,
              text: t.text,
              timestamp: t.timestamp.toISOString(),
              isInterim: t.isInterim,
              confidence: t.confidence,
            })),
            null,
            2,
          );

        default:
          return "";
      }
    },
    [transcripts],
  );

  const copyToClipboard = useCallback(async (): Promise<void> => {
    const text = exportTranscripts("txt");
    await navigator.clipboard.writeText(text);
  }, [exportTranscripts]);

  const downloadTranscript = useCallback(
    (format: "txt" | "srt" | "vtt" | "json", roomId = "meeting"): void => {
      const content = exportTranscripts(format);
      const date = new Date().toISOString().split("T")[0];
      const filename = `transcript_${roomId}_${date}.${format}`;

      const mimeTypes = {
        txt: "text/plain",
        srt: "text/plain",
        vtt: "text/vtt",
        json: "application/json",
      };

      const blob = new Blob([content], { type: mimeTypes[format] });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },
    [exportTranscripts],
  );

  const searchTranscripts = useCallback(
    (query: string): Transcript[] => {
      if (!query.trim()) return transcripts;
      const lowerQuery = query.toLowerCase();
      return transcripts.filter((t) => t.text.toLowerCase().includes(lowerQuery) || t.speakerName.toLowerCase().includes(lowerQuery));
    },
    [transcripts],
  );

  return useMemo(
    (): UseTranscriptsReturn => ({
      transcripts,
      isAvailable,
      clearTranscripts,
      exportTranscripts,
      searchTranscripts,
      copyToClipboard,
      downloadTranscript,
    }),
    [transcripts, isAvailable, clearTranscripts, exportTranscripts, searchTranscripts, copyToClipboard, downloadTranscript],
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
