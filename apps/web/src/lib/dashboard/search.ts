export const sessionShows = ["all", "recording", "transcript", "none"] as const;
export const recordingStatuses = ["ready", "processing", "prepare", "failed", "expired"] as const;
const RANGES = ["today", "7d", "30d", "month", "custom"] as const;
export type RangeKind = (typeof RANGES)[number];

/**
 * The Sessions and Recordings pages keep their filters in the address, so a filtered list can be shared and the back button works.
 * Parsed by hand: the router loads this with the public call route, and a schema library would add about 25 KiB gzip there.
 * A value that doesn't parse is dropped, so a stale link opens the unfiltered list.
 */
export type SessionsSearch = {
  readonly q?: string | undefined;
  readonly range?: RangeKind | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly spaceId?: string | undefined;
  readonly show?: (typeof sessionShows)[number] | undefined;
};
export type RecordingsSearch = Omit<SessionsSearch, "show"> & { readonly status?: (typeof recordingStatuses)[number] | undefined; readonly play?: string | undefined };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const oneOf = <T extends string>(allowed: readonly T[], value: unknown): T | undefined => allowed.find((item) => item === value);
const matching = (pattern: RegExp, value: unknown): string | undefined => (typeof value === "string" && pattern.test(value) ? value : undefined);
const text = (value: unknown): string | undefined => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 && trimmed.length <= 200 ? trimmed : undefined;
};

function filters(search: Record<string, unknown>) {
  return { q: text(search.q), range: oneOf(RANGES, search.range), from: matching(DAY, search.from), to: matching(DAY, search.to), spaceId: matching(UUID, search.spaceId) };
}

export const parseSessionsSearch = (search: Record<string, unknown>): SessionsSearch => ({ ...filters(search), show: oneOf(sessionShows, search.show) });
export const parseRecordingsSearch = (search: Record<string, unknown>): RecordingsSearch => ({ ...filters(search), status: oneOf(recordingStatuses, search.status), play: matching(UUID, search.play) });
