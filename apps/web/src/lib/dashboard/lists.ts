import type { RecordingsQuery, SessionListDTO, SessionRowDTO, SessionsQuery } from "./contracts";
import { rangeDay } from "./format";
import type { RangeKind, RecordingsSearch, SessionsSearch } from "./search";
import { videoGroup, type VideoGroup, type VideoState } from "./recording";

/** Sessions per page. Each row costs one attendance read. */
export const PAGE_ROWS = 10;

export const RANGE_LABEL: Record<Exclude<RangeKind, "custom">, string> = { today: "Today", "7d": "Last 7 days", "30d": "Last 30 days", month: "This month" };

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const endOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, -1);
const localDay = (value: string) => {
  const [year, month, date] = value.split("-").map(Number);
  return new Date(year ?? 0, (month ?? 1) - 1, date ?? 1);
};
/** yyyy-mm-dd in the viewer's time zone, the form a date field and the address use. */
export const dayValue = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

export type Bounds = { readonly kind: RangeKind; readonly from: Date; readonly to: Date; readonly label: string; readonly span: string };

/**
 * The days a range covers, whole days in the viewer's time zone. The end is the end of a day, so it doesn't move
 * between pages of one list. A custom range that is missing or backwards falls back to the last 30 days.
 */
export function bounds(search: Pick<SessionsSearch, "range" | "from" | "to">, now: Date): Bounds {
  const today = startOfDay(now);
  const back = (days: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - days);
  const made = (kind: RangeKind, from: Date, to: Date, label: string): Bounds => ({ kind, from, to, label, span: from.getTime() === startOfDay(to).getTime() ? rangeDay(from) : `${rangeDay(from)} – ${rangeDay(to)}` });
  if (search.range === "today") return made("today", today, endOfDay(now), RANGE_LABEL.today);
  if (search.range === "7d") return made("7d", back(6), endOfDay(now), RANGE_LABEL["7d"]);
  if (search.range === "month") return made("month", new Date(today.getFullYear(), today.getMonth(), 1), endOfDay(now), RANGE_LABEL.month);
  if (search.range === "custom" && search.from && search.to) {
    const from = startOfDay(localDay(search.from));
    const to = endOfDay(localDay(search.to));
    if (from.getTime() <= to.getTime()) return made("custom", from, to, `${rangeDay(from)} – ${rangeDay(startOfDay(to))}`);
  }
  return made("30d", back(29), endOfDay(now), RANGE_LABEL["30d"]);
}

function filters(search: Pick<SessionsSearch, "q" | "range" | "from" | "to" | "spaceId">, now: Date) {
  const range = bounds(search, now);
  return { q: search.q, spaceId: search.spaceId, from: range.from.toISOString(), to: range.to.toISOString() };
}

export const sessionsQueryOf = (search: SessionsSearch, now: Date): SessionsQuery => ({ ...filters(search, now), show: search.show });
export const recordingsQueryOf = (search: RecordingsSearch, now: Date): RecordingsQuery => ({ ...filters(search, now), status: search.status });

/** Time in calls: "21 h 05 min", or "–" when there is none. */
export function timeInCalls(seconds: number): { readonly hours: number; readonly minutes: number } | null {
  const total = Math.round(seconds / 60);
  return total > 0 ? { hours: Math.floor(total / 60), minutes: total % 60 } : null;
}

/** A session as one row shows it. The call page builds these too, with what it already knows. */
export type RowModel = {
  readonly spaceId: string;
  readonly callName: string;
  readonly episodeId: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly people: number;
  readonly video: VideoState | null;
  readonly transcript: SessionRowDTO["transcript"] | "unavailable";
};

export const rowModel = (row: SessionRowDTO): RowModel => ({
  spaceId: row.spaceId,
  callName: row.callName,
  episodeId: row.episode.id,
  startedAt: row.episode.startedAt,
  endedAt: row.episode.endedAt,
  people: row.participantCount,
  video: row.recording?.video ?? null,
  transcript: row.transcript,
});

export type Tone = "ok" | "acc" | "bad" | "mu" | "plain";
export type Badge = { readonly label: string; readonly tone: Tone; readonly icon?: "check" | "spin" | "dot" };

/** The video as a pill: the same words in the Sessions column and the Recordings status. */
export const VIDEO_BADGE: Record<VideoGroup, Badge> = {
  ready: { label: "Ready", tone: "ok", icon: "check" },
  processing: { label: "Processing", tone: "acc", icon: "spin" },
  prepare: { label: "Not prepared", tone: "plain" },
  failed: { label: "Failed", tone: "bad", icon: "dot" },
  expired: { label: "Expired", tone: "mu" },
};

/** The Sessions list calls a ready video "Recording", since the column is about what the session kept. */
export function recordingBadge(video: VideoState | null): Badge {
  if (video === null) return { label: "No recording", tone: "mu" };
  const group = videoGroup(video);
  return group === "ready" ? { label: "Recording", tone: "ok", icon: "check" } : VIDEO_BADGE[group];
}

export function transcriptBadge(transcript: RowModel["transcript"], video: VideoState | null): Badge {
  if (transcript === "ready") return { label: "Transcript", tone: "ok", icon: "check" };
  if (transcript === "processing") return { label: "Processing", tone: "acc", icon: "spin" };
  if (transcript === "unavailable") return { label: "Unavailable", tone: "mu" };
  const group = video === null ? null : videoGroup(video);
  return group === "ready" || group === "processing" || group === "prepare" ? { label: "None yet", tone: "mu" } : { label: "–", tone: "mu" };
}

const dedupe = (rows: readonly SessionRowDTO[]) => [...new Map(rows.map((row) => [row.episode.id, row])).values()];

/** A page of rows joins the list. Totals and the call filter come from the newest answer. */
export function appendPage(current: SessionListDTO, page: SessionListDTO): SessionListDTO {
  return { ...page, rows: dedupe([...current.rows, ...page.rows]) };
}

/** Rows sort newest first, so a row is older than another when it started earlier, or at the same time with a smaller ID. */
const older = (row: SessionRowDTO, than: SessionRowDTO) => Date.parse(row.episode.startedAt) < Date.parse(than.episode.startedAt) || (row.episode.startedAt === than.episode.startedAt && row.episode.id < than.episode.id);

/** A poll reads the first page only, so only these rows can still change. Rows from older pages stay as they were loaded. */
export const refreshable = (list: SessionListDTO) => list.rows.slice(0, PAGE_ROWS);

/**
 * The first page read again is the truth for the days it covers: rows that stopped matching leave, new ones arrive, the rest
 * update. Pages the reader loaded after it stay, and so does the cursor to the page after them.
 */
export function mergeFirstPage(current: SessionListDTO, fresh: SessionListDTO): SessionListDTO {
  const last = fresh.rows.at(-1);
  const tail = fresh.nextCursor === null || !last ? [] : current.rows.filter((row) => older(row, last));
  return { ...fresh, rows: dedupe([...fresh.rows, ...tail]), nextCursor: tail.length ? current.nextCursor : fresh.nextCursor };
}
