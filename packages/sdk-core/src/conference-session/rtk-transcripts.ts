import type { Transcript } from "./types.ts";
import type { RtkSignalingDeps } from "./rtk-signaling-deps.ts";

const mapRtkTranscript = (data: unknown): Transcript | null => {
  if (!data || typeof data !== "object") {
    return null;
  }

  const raw = data as Record<string, unknown>;

  const participantId = (raw.peerId as string) ?? (raw.userId as string) ?? (raw.participantId as string) ?? (raw.customParticipantId as string) ?? "";

  const speakerName = (raw.name as string) ?? (raw.participantName as string) ?? (raw.displayName as string) ?? "Unknown";

  const text = (raw.transcript as string) ?? (raw.text as string) ?? (raw.content as string) ?? "";

  if (!text) {
    return null;
  }

  const isInterim = raw.isPartialTranscript === true;

  return {
    id: (raw.id as string) ?? crypto.randomUUID(),
    participantId,
    speakerName,
    text,
    timestamp: raw.date ? new Date(raw.date as string | number) : raw.timestamp ? new Date(raw.timestamp as string | number) : new Date(),
    isInterim,
    confidence: raw.confidence as number | undefined,
  };
};

export const setupRtkTranscriptListener = (deps: RtkSignalingDeps): void => {
  const rtkClient = deps.getRtkClient();
  if (!rtkClient) {
    return;
  }

  const ai = (
    rtkClient as unknown as {
      ai?: {
        transcripts?: unknown[];
        on?: (event: string, handler: (data: unknown) => void) => void;
      };
    }
  ).ai;

  if (!ai) {
    return;
  }

  const aiRecord = ai as Record<string, unknown>;
  if (typeof aiRecord.enable === "function") {
    try {
      (aiRecord.enable as () => void)();
    } catch {
      // best effort
    }
  }
  if (typeof aiRecord.start === "function") {
    try {
      (aiRecord.start as () => void)();
    } catch {
      // best effort
    }
  }
  if (typeof aiRecord.startTranscription === "function") {
    try {
      (aiRecord.startTranscription as () => void)();
    } catch {
      // best effort
    }
  }

  if (Array.isArray(ai.transcripts)) {
    for (const transcriptData of ai.transcripts) {
      const transcript = mapRtkTranscript(transcriptData);
      if (transcript) {
        deps.getTranscripts().push(transcript);
      }
    }
  }

  const eventNames = ["transcript", "transcription", "transcriptUpdate", "newTranscript", "message"];

  if (typeof ai.on !== "function") {
    return;
  }

  for (const eventName of eventNames) {
    try {
      ai.on(eventName, (data: unknown) => {
        const transcript = mapRtkTranscript(data);
        if (!transcript) {
          return;
        }

        deps.getTranscripts().push(transcript);
        deps.emit("transcript", transcript);

        if (!transcript.isInterim) {
          deps.getWsClient()?.sendTranscript(transcript);
        }
      });
    } catch {
      // unsupported event
    }
  }
};
