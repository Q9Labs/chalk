/** Who talked in a session, measured by the API from its transcripts. Times are milliseconds since the session started. */
export type TalkSpeakerDTO = { key: string; name: string; talkMs: number; share: number; turns: number; buckets: readonly number[] };
export type TalkTimeDTO =
  | {
      kind: "available";
      durationMs: number;
      totalTalkMs: number;
      overlapMs: number;
      silenceMs: number;
      bucketMs: number;
      recordings: readonly { id: string; offsetMs: number; transcribed: boolean }[];
      speakers: readonly TalkSpeakerDTO[];
    }
  | { kind: "no-transcript" | "pending" | "live" | "unavailable" };

export type MeasuredTalk = Extract<TalkTimeDTO, { kind: "available" }>;

/** "42 s", "12 min 5 s", "1 h 5 min": a stretch of talking in words a person would say. */
export function talkLength(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes} min ${seconds % 60} s` : `${minutes} min`;
  const rest = minutes % 60;
  return rest ? `${Math.floor(minutes / 60)} h ${rest} min` : `${minutes / 60} h`;
}

/** "62%", and "<1%" for someone who spoke a little so their row doesn't read as zero. */
export function sharePercent(share: number): string {
  if (share > 0 && share < 0.005) return "<1%";
  return `${Math.round(share * 100)}%`;
}

/** The session time under a pointer that is `offset` pixels along a timeline `width` pixels wide, from the session's start to its end. */
export function sessionMsAt(offset: number, width: number, durationMs: number): number {
  if (width <= 0) return 0;
  return Math.min(Math.max(offset / width, 0), 1) * durationMs;
}

const offsetOf = (talk: MeasuredTalk, recordingId: string) => talk.recordings.find((recording) => recording.id === recordingId)?.offsetMs;

/** Where a point of the session sits in the playing recording, in seconds. Null when the recording isn't part of the measurement. */
export function recordingSeconds(talk: MeasuredTalk, recordingId: string, sessionMs: number): number | null {
  const offset = offsetOf(talk, recordingId);
  return offset === undefined ? null : Math.max(0, (sessionMs - offset) / 1000);
}

/** Where the playing recording's clock sits on the session, as a 0 to 1 fraction of the session. Null when it can't be placed. */
export function playheadFraction(talk: MeasuredTalk, recordingId: string, seconds: number): number | null {
  const offset = offsetOf(talk, recordingId);
  if (offset === undefined || talk.durationMs <= 0) return null;
  return Math.min(Math.max((offset + seconds * 1000) / talk.durationMs, 0), 1);
}
