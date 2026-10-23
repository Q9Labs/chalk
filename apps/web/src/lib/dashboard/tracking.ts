import type { CueDTO, RecordingDTO, TranscriptDTO } from "./contracts";
import { DashboardRequestError, errorMessage } from "./client";
import { completedTranscript, lapsed, openWindow, pendingTranscript, transcriptState, videoState, workingRecording, type TranscriptState } from "./recording";

/**
 * A past session tracks every recording attempt and every attempt's transcripts, whether the page shows them or not.
 * The page load reads them once. After that the paced scheduler is the only reader: one read per tick, never two at
 * once, and each read lands on its own item. Selection only decides what the page shows, never what it reads.
 */

/** How an item was last read. A failure stays on the item until its next answer. */
export type Read = {
  /** The page's clock when the last answer came. */
  readonly at: number;
  readonly failures: number;
  readonly retryAt: number;
  readonly failure: { readonly kind: "transient" | "terminal"; readonly message: string } | null;
  /** A refused action asks for a reread at the next tick, so only the server's answer removes it. */
  readonly stale: boolean;
};

export type Attempt = {
  /** `transcripts` stays undefined until the attempt's transcript list is read. */
  readonly recording: RecordingDTO;
  /** The server's clock minus the page's, from the response that carried this recording's deadlines. */
  readonly offset: number;
  /** Counts actions that changed this attempt, so a read that started before one can't undo it. */
  readonly writes: number;
  /** The recording's own read: its video, its windows and their deadlines. */
  readonly read: Read;
  /** The transcript list's read. A recording read that lists them counts as one. */
  readonly listRead: Read;
  /** The lines of the attempt's finished transcript, read only while the page shows it. */
  readonly cues: { readonly transcriptId: string; readonly cues: readonly CueDTO[] } | null;
  readonly cuesRead: Read;
};

export type Due = ({ readonly kind: "recording" | "transcripts" } | { readonly kind: "cues"; readonly transcriptId: string }) & { readonly id: string; readonly at: number };

/**
 * An idle attempt with an open window is read again this often, so a server that closes the window before its
 * deadline (a retention change or a deletion) is noticed without a click. Windows last hours to days and their
 * deadlines are already read on time, so five minutes caps how long a dead action can show at one small read per open
 * attempt, and only while the tab is visible.
 */
export const REVALIDATE_MS = 5 * 60_000;
const RETRY_MS = 5_000;
const RETRY_CAP_MS = 60_000;

export function succeeded(at: number): Read {
  return { at, failures: 0, retryAt: 0, failure: null, stale: false };
}

/** A failed read, sorted by `failureKind`. A transient failure backs off; a terminal one is never read again. */
export function failed(read: Read, kind: "transient" | "terminal", error: unknown, at: number): Read {
  const failure = { kind, message: errorMessage(error) };
  if (kind === "terminal") return { ...read, at, failure, stale: false };
  const failures = Math.min(read.failures + 1, 6);
  const wait = error instanceof DashboardRequestError && error.retryAfterSeconds !== undefined ? error.retryAfterSeconds * 1000 : Math.min(RETRY_MS * 2 ** (failures - 1), RETRY_CAP_MS);
  return { at, failures, retryAt: at + wait, failure, stale: false };
}

export function attempt(recording: RecordingDTO, offset: number, at: number): Attempt {
  return { recording, offset, writes: 0, read: succeeded(at), listRead: succeeded(at), cues: null, cuesRead: succeeded(at) };
}

/** What the page shows: the newest playable video, and separately the newest finished transcript. */
export function selection(attempts: readonly Attempt[]) {
  const usable = (item: Attempt) => ["preparable", "retryable", "preparing"].includes(videoState(item.recording));
  // A playable export first, then an attempt that can still be prepared, so a failed newest attempt never hides a usable older one.
  const video = attempts.find((item) => videoState(item.recording) === "play") ?? attempts.find(usable) ?? attempts[0];
  // Attempts are newest first, so a later attempt than the one shown sits before it.
  const newer = video ? attempts.slice(0, attempts.indexOf(video)).find(usable) : undefined;
  // Until a transcript finishes, the newest one being made is shown, so the page doesn't offer to make a second.
  const transcript = attempts.find((item) => item.recording.transcripts?.some(completedTranscript)) ?? attempts.find((item) => item.recording.transcripts?.some(pendingTranscript)) ?? video;
  return { video, newer, transcript };
}

export type TranscriptView = { readonly kind: "loading" } | { readonly kind: "unreadable"; readonly message: string } | { readonly kind: "ready"; readonly transcript: TranscriptDTO; readonly cues: readonly CueDTO[] } | { readonly kind: Exclude<TranscriptState, "ready"> };

/** The transcript panel for one attempt. A failed read marks only this panel, and a transient one keeps the last good answer. */
export function transcriptView(item: Attempt): TranscriptView {
  const { read, listRead, cuesRead, recording } = item;
  if (listRead.failure?.kind === "terminal") return { kind: "unreadable", message: listRead.failure.message };
  const listed = recording.transcripts;
  if (listed === undefined) return listRead.failure ? { kind: "unreadable", message: listRead.failure.message } : { kind: "loading" };
  const transcript = listed.find(completedTranscript) ?? listed[0] ?? null;
  // Without a transcript the recording's own preparation decides, so a recording that can't be read can't decide it.
  if (!transcript && read.failure?.kind === "terminal") return { kind: "unreadable", message: read.failure.message };
  const kind = transcriptState(recording, transcript);
  if (kind !== "ready" || !transcript) return { kind: kind === "ready" ? "failed" : kind };
  if (item.cues?.transcriptId === transcript.id) return { kind: "ready", transcript, cues: item.cues.cues };
  return cuesRead.failure ? { kind: "unreadable", message: cuesRead.failure.message } : { kind: "loading" };
}

function readable(read: Read, now: number): boolean {
  return read.failure?.kind !== "terminal" && now >= read.retryAt;
}

/**
 * Every read due now. A recording is due while the server reports work on it, once a deadline has passed by the
 * server's clock and the server still reports the window open, and every `REVALIDATE_MS` while a window is open. Its
 * transcript list is due until it is read and while any transcript on it is being made. Either is also due after a
 * transient failure or a refused action.
 */
export function dueReads(attempts: readonly Attempt[], now: number): Due[] {
  const shown = selection(attempts).transcript;
  return attempts.flatMap((item): Due[] => {
    const { recording, read, listRead, cuesRead } = item;
    const id = recording.id;
    const open = openWindow(recording) && (lapsed(recording, now + item.offset) || now - read.at >= REVALIDATE_MS);
    const listing = recording.transcripts === undefined || recording.transcripts.some(pendingTranscript);
    const due: Due[] = [];
    if (readable(read, now) && (workingRecording(recording) || open || read.stale || read.failure !== null)) due.push({ kind: "recording", id, at: read.at });
    if (readable(listRead, now) && (listing || listRead.stale || listRead.failure !== null)) due.push({ kind: "transcripts", id, at: listRead.at });
    const done = item === shown ? recording.transcripts?.find(completedTranscript) : undefined;
    if (done && item.cues?.transcriptId !== done.id && readable(cuesRead, now)) due.push({ kind: "cues", id, transcriptId: done.id, at: cuesRead.at });
    return due;
  });
}

/** The read for this tick: the due item read longest ago, so every due item takes its turn. */
export function nextRead(attempts: readonly Attempt[], now: number): Due | undefined {
  return dueReads(attempts, now).reduce<Due | undefined>((oldest, due) => (oldest === undefined || due.at < oldest.at ? due : oldest), undefined);
}

/**
 * When the next read falls due on the page's clock, while none is due now: a retry, the next revalidation of an open
 * window, or a deadline moved from the server's clock to the page's with the attempt's offset.
 */
export function nextDue(attempts: readonly Attempt[], now: number): number | undefined {
  const moments = attempts.flatMap(({ recording, read, listRead, cuesRead, offset }) => {
    const retries = [read, listRead, cuesRead].filter((item) => item.failure?.kind === "transient").map((item) => item.retryAt);
    if (read.failure?.kind === "terminal" || !openWindow(recording)) return retries;
    const deadlines = [recording.sourceExpiresAt, recording.transcriptionExpiresAt].flatMap((deadline) => (deadline === null ? [] : [Date.parse(deadline) - offset]));
    return [...retries, read.at + REVALIDATE_MS, ...deadlines];
  });
  const next = Math.min(...moments.filter((moment) => moment > now));
  return Number.isFinite(next) ? next : undefined;
}
