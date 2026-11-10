import { Schema } from "effect";
import { z } from "zod";
import type { Episode, Recording, Space, Transcript } from "@q9labsai/chalk-client/effect";
import { EpisodeIdSchema, SpaceIdSchema } from "@q9labsai/chalk-client/effect";
import type { Engine } from "./engine";
import { attendance, run } from "./engine";
import { recordingDTO } from "./dto";
import { DashboardError } from "./http";
import { keptRecording, videoGroup, videoState, type VideoGroup } from "../src/lib/dashboard/recording";
import type { RecordingsQuery, SessionListDTO, SessionRowDTO, SessionsQuery, SessionTotalsDTO } from "../src/lib/dashboard/contracts";

/*
 * The API lists Episodes only inside one Space, so an account-wide list reads each Space that was active in the range.
 * Recordings and transcripts list across the account, so one walk of each joins to those Episodes in memory. Every read
 * is bounded; when a bound stops the scan the answer says `truncated`, and the oldest sessions are the ones left out.
 * A request is stateless: the cursor is the position in the sorted list, and each page reads the scan again.
 */

/** Sessions per page. Each row costs one attendance read. */
export const PAGE_ROWS = 10;
/** The engine's own maximum page, MaxPageSize in apps/api/internal/pagination/pagination.go. */
const LIST = 100;
/** Space reads: three pages of 100, which is also what one activity read covers (300 ids). */
const SPACE_PAGES = 3;
/** Calls whose Episodes one answer reads. */
export const CALL_CAP = 40;
/** Pages of one call's Episodes, of the account's recordings, and of its transcripts. */
const WALK_PAGES = 3;
/** The Episode list orders by creation and rows by start, and a recording or transcript is made after its Episode starts, so a walk stops one episode-length (at most a day) past the range. */
const STOP_SLACK = 86_400_000;
/** Calls shown in the Call filter. */
const CALL_FILTER = 8;

type Range = { readonly from: number | null; readonly to: number | null };
type Spans<T> = { readonly items: T[]; readonly truncated: boolean };

/** Pages through a newest-first list until a page reaches past the range, the list ends, or the page bound is spent. */
async function walk<T extends { created_at: string }>(read: (cursor: string | undefined) => Promise<{ items: readonly T[]; next: string | null }>, from: number | null): Promise<Spans<T>> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < WALK_PAGES; page++) {
    const result = await read(cursor);
    items.push(...result.items);
    const last = result.items.at(-1);
    if (result.next === null || last === undefined || (from !== null && Date.parse(last.created_at) < from - STOP_SLACK)) return { items, truncated: false };
    cursor = result.next;
  }
  return { items, truncated: true };
}

async function allSpaces(engine: Engine): Promise<Spans<Space>> {
  const items: Space[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < SPACE_PAGES; page++) {
    const result = await run(engine.api.spaces.listSpaces({ params: { tenant_id: engine.tenantId }, query: { page_size: LIST, cursor } }));
    items.push(...result.spaces);
    if (result.pagination.next_cursor === null) return { items, truncated: false };
    cursor = result.pagination.next_cursor;
  }
  return { items, truncated: true };
}

/** The calls with a session in the range, most recent first. A call whose latest session began before the range has none inside it. */
async function activeCalls(engine: Engine, range: Range): Promise<Spans<Space>> {
  const { items: spaces, truncated } = await allSpaces(engine);
  if (!spaces.length) return { items: [], truncated: false };
  const activity = await run(engine.api.spaces.listSpaceActivity({ params: { tenant_id: engine.tenantId }, query: { space_ids: spaces.map((space) => space.id).join(",") } }));
  const latest = new Map<string, number>();
  for (const row of activity.spaces) if (row.latest_episode) latest.set(row.space_id, Date.parse(row.latest_episode.started_at));
  const active = spaces
    .filter((space) => {
      const started = latest.get(space.id);
      return started !== undefined && (range.from === null || started >= range.from) && (range.to === null || Date.parse(space.created_at) <= range.to);
    })
    .sort((a, b) => (latest.get(b.id) ?? 0) - (latest.get(a.id) ?? 0));
  return { items: active, truncated };
}

type Scan = { readonly calls: Space[]; readonly episodes: Episode[]; readonly recordings: Recording[]; readonly transcripts: Transcript[]; readonly truncated: boolean };

async function scan(engine: Engine, range: Range, filter: { readonly spaceId?: string; readonly q?: string }): Promise<Scan> {
  const found = await activeCalls(engine, range);
  const name = filter.q?.toLowerCase();
  const calls = found.items.filter((space) => (filter.spaceId === undefined || space.id === filter.spaceId) && (!name || space.name.toLowerCase().includes(name)));
  const read = calls.slice(0, CALL_CAP);
  const tenant = { tenant_id: engine.tenantId };
  // One call's recordings list can be asked for directly; any more calls share the account-wide list.
  const only = read.length === 1 ? read[0]?.id : undefined;
  const [episodes, recordings, transcripts] = await Promise.all([
    Promise.all(
      read.map((space) =>
        walk(async (cursor) => {
          const result = await run(engine.api.episodes.listEpisodes({ params: { ...tenant, space_id: Schema.decodeUnknownSync(SpaceIdSchema)(space.id) }, query: { page_size: LIST, cursor } }));
          return { items: result.episodes, next: result.pagination.next_cursor };
        }, range.from),
      ),
    ),
    read.length
      ? walk(async (cursor) => {
          const result = await run(engine.api.recordings.listRecordings({ params: tenant, query: { page_size: LIST, cursor, ...(only === undefined ? {} : { space_id: Schema.decodeUnknownSync(SpaceIdSchema)(only) }) } }));
          return { items: result.recordings, next: result.pagination.next_cursor };
        }, range.from)
      : { items: [], truncated: false },
    read.length
      ? walk(async (cursor) => {
          const result = await run(engine.api.transcripts.listTranscripts({ params: tenant, query: { page_size: LIST, cursor } }));
          return { items: result.transcripts, next: result.pagination.next_cursor };
        }, range.from)
      : { items: [], truncated: false },
  ]);
  return {
    calls: found.items,
    episodes: episodes.flatMap((one) => one.items),
    recordings: recordings.items,
    transcripts: transcripts.items,
    truncated: found.truncated || calls.length > CALL_CAP || episodes.some((one) => one.truncated) || recordings.truncated || transcripts.truncated,
  };
}

function grouped<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(key(item));
    if (group) group.push(item);
    else groups.set(key(item), [item]);
  }
  return groups;
}

const PENDING = new Set(["pending", "processing", "preparing", "transcribing", "verifying", "retryable_failure"]);

/** One row for each ended Episode inside the range, newest first. `participantCount` is filled in for a page later. */
function sessionRows(input: Scan & { readonly names: ReadonlyMap<string, string> }, range: Range): SessionRowDTO[] {
  const recordingsOf = grouped(input.recordings, (recording) => recording.episode_id);
  const transcriptsOf = grouped(input.transcripts, (transcript) => transcript.recording_id);
  const rows: SessionRowDTO[] = [];
  for (const episode of input.episodes) {
    const started = Date.parse(episode.started_at);
    if (episode.status !== "ended" || !episode.ended_at || (range.from !== null && started < range.from) || (range.to !== null && started > range.to)) continue;
    const recordings = (recordingsOf.get(episode.id) ?? []).map(recordingDTO).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const kept = keptRecording(recordings);
    const transcripts = kept ? (transcriptsOf.get(kept.id) ?? []).filter((transcript) => transcript.status !== "deleted" && !transcript.deleted_at) : [];
    rows.push({
      spaceId: episode.space_id,
      callName: input.names.get(episode.space_id) ?? "Call",
      episode: { id: episode.id, status: episode.status, startedAt: episode.started_at, endedAt: episode.ended_at },
      participantCount: 0,
      recording: kept ? { id: kept.id, video: videoState(kept), failureMessage: kept.failureMessage } : null,
      transcript: transcripts.some((item) => item.status === "completed" || item.status === "complete") ? "ready" : transcripts.some((item) => PENDING.has(item.status)) ? "processing" : "none",
      transcriptIds: transcripts.map((item) => item.id),
    });
  }
  return rows.sort(newestFirst);
}

const newestFirst = (a: SessionRowDTO, b: SessionRowDTO) => Date.parse(b.episode.startedAt) - Date.parse(a.episode.startedAt) || (a.episode.id < b.episode.id ? 1 : -1);

/** Rows sort newest first, so a row comes after a position when it started earlier, or at the same time with a smaller ID. */
function follows(row: SessionRowDTO, at: { readonly t: number; readonly id: string }): boolean {
  const started = Date.parse(row.episode.startedAt);
  return started < at.t || (started === at.t && row.episode.id < at.id);
}

function totals(rows: readonly SessionRowDTO[]): SessionTotalsDTO {
  const video: Record<VideoGroup, number> = { ready: 0, processing: 0, prepare: 0, failed: 0, expired: 0 };
  let seconds = 0;
  let recorded = 0;
  let transcripts = 0;
  for (const row of rows) {
    seconds += Math.max(0, Date.parse(row.episode.endedAt ?? row.episode.startedAt) - Date.parse(row.episode.startedAt)) / 1000;
    if (row.recording) {
      recorded++;
      video[videoGroup(row.recording.video)]++;
    }
    if (row.transcript === "ready") transcripts++;
  }
  return { sessions: rows.length, seconds, recorded, transcripts, video };
}

const position = z.object({ t: z.number().int(), id: z.string().max(64) });

function encodeCursor(row: SessionRowDTO): string {
  return btoa(JSON.stringify({ t: Date.parse(row.episode.startedAt), id: row.episode.id }))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function decodeCursor(cursor: string): z.infer<typeof position> {
  try {
    return position.parse(JSON.parse(atob(cursor.replaceAll("-", "+").replaceAll("_", "/"))));
  } catch {
    throw new DashboardError(400, "invalid_request");
  }
}

async function list(engine: Engine, query: SessionsQuery | RecordingsQuery, keep: (row: SessionRowDTO) => boolean): Promise<SessionListDTO> {
  const range: Range = { from: query.from ? Date.parse(query.from) : null, to: query.to ? Date.parse(query.to) : null };
  const found = await scan(engine, range, { spaceId: query.spaceId, q: query.q });
  const matching = sessionRows({ ...found, names: new Map(found.calls.map((space) => [space.id, space.name])) }, range).filter(keep);
  const after = query.cursor ? decodeCursor(query.cursor) : null;
  const later = after ? matching.filter((row) => follows(row, after)) : matching;
  const page = later.slice(0, PAGE_ROWS);
  const people = await Promise.all(page.map((row) => attendance(engine, { tenant_id: engine.tenantId, space_id: Schema.decodeUnknownSync(SpaceIdSchema)(row.spaceId), episode_id: Schema.decodeUnknownSync(EpisodeIdSchema)(row.episode.id) }).then((result) => result.participants.length)));
  const last = page.at(-1);
  return {
    rows: page.map((row, index) => ({ ...row, participantCount: people[index] ?? 0 })),
    totals: totals(matching),
    calls: found.calls.slice(0, CALL_FILTER).map((space) => ({ id: space.id, name: space.name })),
    nextCursor: later.length > page.length && last ? encodeCursor(last) : null,
    truncated: found.truncated,
  };
}

export function sessionsPage(engine: Engine, query: SessionsQuery): Promise<SessionListDTO> {
  const show = query.show ?? "all";
  return list(engine, query, (row) => (show === "all" ? true : show === "recording" ? row.recording !== null : show === "transcript" ? row.transcript === "ready" : row.recording === null));
}

export function recordingsPage(engine: Engine, query: RecordingsQuery): Promise<SessionListDTO> {
  return list(engine, query, (row) => row.recording !== null && (query.status === undefined || videoGroup(row.recording.video) === query.status));
}
