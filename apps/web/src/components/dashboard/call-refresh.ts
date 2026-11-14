import { act, DashboardRequestError, readPage } from "../../lib/dashboard/client";
import type { CallMetadataDTO, CallMetadataQuery, CallPageDTO, CallStatusDTO, RecordingDTO, TranscriptDTO } from "../../lib/dashboard/contracts";
import type { RowModel } from "../../lib/dashboard/lists";
import { keptRecording, videoState, workingRecording } from "../../lib/dashboard/recording";

/** How a call page keeps itself current: one status read per tick, and one metadata read per ten seconds. */

const PENDING_TRANSCRIPTS: ReadonlySet<string> = new Set(["pending", "processing", "preparing", "transcribing", "verifying", "retryable_failure"]);

const STATUS_MS = { knocks: 3000, quiet: 5000 } as const;
const METADATA_EVERY_MS = 10_000;
const LIFECYCLE_EVERY_MS = 30_000;
/** An artifact read that fails with one of these means the artifact is gone or off limits, not that the page is broken. */
const ABSENT = [403, 404, 410];

export type CallRefresh = {
  /** Pages of history on screen, so a status change refreshes all of them. */
  pages: number;
  metadataAfter: number;
  nextTarget: number;
  /** Recordings whose transcript list is not yet known. */
  unlisted: Set<string>;
  /** Recordings whose transcripts cannot be read. */
  unavailable: Set<string>;
  lifecycle: { spaceId: string; after: number; pending: boolean };
};

export function newCallRefresh(spaceId: string): CallRefresh {
  return { pages: 1, metadataAfter: Date.now() + METADATA_EVERY_MS, nextTarget: 0, unlisted: new Set(), unavailable: new Set(), lifecycle: { spaceId, after: 0, pending: false } };
}

type Target = CallMetadataQuery | { kind: "live" } | { kind: "transcripts"; spaceId: string; episodeId: string; id: string };
type Recordings = (recordings: RecordingDTO[]) => RecordingDTO[];

export async function loadCallPage(spaceId: string, refresh: CallRefresh): Promise<CallPageDTO> {
  let data = await readPage("call", { spaceId });
  // Keep expanded history when a status change requires a page refresh.
  for (let page = 1; page < refresh.pages && data.nextCursor; page++) {
    const older = await readPage("call", { spaceId, cursor: data.nextCursor });
    data = { ...data, episodes: [...data.episodes, ...older.episodes], nextCursor: older.nextCursor };
  }
  refresh.unlisted.clear();
  refresh.unavailable.clear();
  return data;
}

function needsArtifacts(recording: RecordingDTO, refresh: CallRefresh): boolean {
  if (workingRecording(recording)) return true;
  if (refresh.unavailable.has(recording.id)) return false;
  return recording.transcripts === undefined || refresh.unlisted.has(recording.id) || recording.transcripts.some((transcript) => PENDING_TRANSCRIPTS.has(transcript.status));
}

/** Milliseconds until the next status read, or undefined when nothing on the page can change by itself. */
export function callInterval(data: CallPageDTO, refresh: CallRefresh): number | undefined {
  if (data.knocks.length) return STATUS_MS.knocks;
  const changing = refresh.lifecycle.pending || (!data.call.archived && data.call.admission === "knock") || data.live || data.episodes.some((episode) => episode.status !== "ended" || episode.recordings.some((recording) => needsArtifacts(recording, refresh)));
  return changing ? STATUS_MS.quiet : undefined;
}

function mapRecordings(data: CallPageDTO, change: Recordings): CallPageDTO {
  return { ...data, episodes: data.episodes.map((session) => ({ ...session, recordings: change(session.recordings) })) };
}

function lifecycleChanged(data: CallPageDTO, status: CallStatusDTO): boolean {
  const episode = data.episodes.find((item) => item.status !== "ended");
  if (status.episode?.status === "active" && data.live?.id !== status.episode.id) return true;
  if ((data.episodes[0]?.id ?? null) !== status.latestEpisodeId) return true;
  if ((episode?.id ?? data.live?.id) !== status.episode?.id) return true;
  return (episode?.status ?? (data.live ? "active" : undefined)) !== status.episode?.status;
}

/** Reload the newest page after a start or end. Older ended sessions stay snapshots until an explicit page refresh. */
async function reloadAfterLifecycle(data: CallPageDTO, spaceId: string, refresh: CallRefresh): Promise<CallPageDTO> {
  // Charge failed attempts too. Recheck on later ticks so the final state is fetched.
  refresh.lifecycle.after = Date.now() + LIFECYCLE_EVERY_MS;
  const fresh = await readPage("call", { spaceId });
  const expanded = refresh.pages > 1;
  const older = expanded ? data.episodes.filter((item) => item.status === "ended" && !fresh.episodes.some((current) => current.id === item.id)) : [];
  refresh.lifecycle.pending = false;
  return { ...fresh, episodes: [...fresh.episodes, ...older], nextCursor: expanded ? data.nextCursor : fresh.nextCursor };
}

function targets(data: CallPageDTO, spaceId: string, refresh: CallRefresh): Target[] {
  const found: Target[] = data.live ? [{ kind: "live" }] : [];
  for (const session of data.episodes) {
    for (const recording of session.recordings) {
      if (workingRecording(recording)) found.push({ kind: "recording", spaceId, id: recording.id });
      if (refresh.unavailable.has(recording.id)) continue;
      if (recording.transcripts === undefined || refresh.unlisted.has(recording.id)) found.push({ kind: "transcripts", spaceId, episodeId: session.id, id: recording.id });
      else found.push(...recording.transcripts.filter((transcript) => PENDING_TRANSCRIPTS.has(transcript.status)).map((transcript): Target => ({ kind: "transcript", spaceId, id: transcript.id })));
    }
  }
  return found;
}

/** Only artifact reads can reconcile absence here. Status and page failures still reach useLoad, which handles access loss, sign-in and backoff. */
function isAbsent(error: unknown): boolean {
  return error instanceof DashboardRequestError && ABSENT.includes(error.status);
}

async function refreshLive(data: CallPageDTO, spaceId: string): Promise<CallPageDTO> {
  const roster = await readPage("home-status", { spaceIds: spaceId });
  const current = roster.live[0]?.episode ?? null;
  return current?.id === data.live?.id ? { ...data, live: current } : data;
}

async function refreshTranscriptList(data: CallPageDTO, target: Extract<Target, { kind: "transcripts" }>, refresh: CallRefresh): Promise<CallPageDTO> {
  let result: { transcripts: TranscriptDTO[] };
  try {
    result = await act("past-session", { action: "transcripts", spaceId: target.spaceId, episodeId: target.episodeId, recordingId: target.id, view: "call" });
  } catch (error) {
    if (!isAbsent(error)) throw error;
    refresh.unlisted.delete(target.id);
    refresh.unavailable.add(target.id);
    return data;
  }
  refresh.unlisted.delete(target.id);
  return mapRecordings(data, (recordings) => recordings.map((recording) => (recording.id === target.id ? { ...recording, transcripts: result.transcripts } : recording)));
}

function dropTarget(data: CallPageDTO, target: CallMetadataQuery): CallPageDTO {
  return mapRecordings(data, (recordings) =>
    recordings.filter((recording) => target.kind !== "recording" || recording.id !== target.id).map((recording) => (target.kind === "transcript" ? { ...recording, transcripts: recording.transcripts?.filter((transcript) => transcript.id !== target.id) } : recording)),
  );
}

function noteTranscriptListing(result: CallMetadataDTO, refresh: CallRefresh) {
  if (result.kind !== "recording") return;
  const { id, transcripts } = result.recording;
  if (transcripts !== undefined) {
    refresh.unlisted.delete(id);
    refresh.unavailable.delete(id);
  } else if (!refresh.unavailable.has(id)) refresh.unlisted.add(id);
}

function applyMetadata(data: CallPageDTO, result: CallMetadataDTO): CallPageDTO {
  return mapRecordings(data, (recordings) =>
    recordings.map((recording) => {
      if (result.kind === "recording") return recording.id === result.recording.id ? { ...recording, ...result.recording, transcripts: result.recording.transcripts ?? recording.transcripts } : recording;
      return { ...recording, transcripts: recording.transcripts?.map((transcript) => (transcript.id === result.transcript.id ? result.transcript : transcript)) };
    }),
  );
}

async function refreshArtifact(data: CallPageDTO, target: CallMetadataQuery, refresh: CallRefresh): Promise<CallPageDTO> {
  let result: CallMetadataDTO;
  try {
    result = await readPage("call-metadata", target);
  } catch (error) {
    if (!isAbsent(error)) throw error;
    return dropTarget(data, target);
  }
  noteTranscriptListing(result, refresh);
  return applyMetadata(data, result);
}

/** One metadata read per ten seconds, rotating through whatever on the page is still changing. */
async function refreshOneArtifact(data: CallPageDTO, spaceId: string, refresh: CallRefresh): Promise<CallPageDTO> {
  if (Date.now() < refresh.metadataAfter) return data;
  refresh.metadataAfter = Date.now() + METADATA_EVERY_MS;
  const pending = targets(data, spaceId, refresh);
  if (!pending.length) return data;
  const target = pending[refresh.nextTarget++ % pending.length];
  if (!target) return data;
  if (target.kind === "live") return refreshLive(data, spaceId);
  if (target.kind === "transcripts") return refreshTranscriptList(data, target, refresh);
  return refreshArtifact(data, target, refresh);
}

/** One tick: the cheap status read, then a reload when the lifecycle moved, else one artifact read. */
export async function readCallTick(data: CallPageDTO, spaceId: string, refresh: CallRefresh): Promise<CallPageDTO> {
  const status = await readPage("call-status", { spaceId });
  if (refresh.lifecycle.spaceId !== spaceId) refresh.lifecycle = { spaceId, after: 0, pending: false };
  const changed = lifecycleChanged(data, status);
  refresh.lifecycle.pending = changed;
  if (changed && Date.now() >= refresh.lifecycle.after) return reloadAfterLifecycle(data, spaceId, refresh);
  return refreshOneArtifact({ ...data, knocks: status.knocks }, spaceId, refresh);
}

/** What a session kept: its newest recording's video, and that recording's best transcript. */
export function keptByRow(recordings: readonly RecordingDTO[], unavailable: ReadonlySet<string>): Pick<RowModel, "video" | "transcript"> {
  const recording = keptRecording(recordings);
  if (!recording) return { video: null, transcript: "none" };
  const video = videoState(recording);
  if (unavailable.has(recording.id)) return { video, transcript: "unavailable" };
  const transcripts = recording.transcripts ?? [];
  if (transcripts.some((item) => item.status === "completed" || item.status === "complete")) return { video, transcript: "ready" };
  if (transcripts.some((item) => PENDING_TRANSCRIPTS.has(item.status))) return { video, transcript: "processing" };
  return { video, transcript: "none" };
}
