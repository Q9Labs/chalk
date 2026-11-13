import { HOME_STATUS_ROWS, type CallDTO, type HomeCallDTO, type HomeDTO, type HomeStatusDTO, type LiveDTO } from "../../lib/dashboard/contracts";
import { readPage } from "../../lib/dashboard/client";
import { shareableLink } from "../../lib/dashboard/format";

/** A call's shareable link: the row's own, or a bounded invite-only read. */
export async function inviteLink(call: HomeCallDTO): Promise<string> {
  const link = call.inviteUrl ?? (await readPage("call-invite", { spaceId: call.id })).inviteUrl;
  if (!link) throw new Error("This call has no link yet");
  return shareableLink(link);
}

/** A Home row: the call with its live Episode, which every status check answers along with whether it is archived. */
export type Row = HomeCallDTO & { live: LiveDTO["episode"] };
/** A mutation returns the bare call; keep the row's link, activity, people and live Episode. */
export const merge = (row: Row, call: CallDTO): Row => ({ ...row, ...call });
/**
 * Home holds the 300 newest calls it knows, newest first, archived ones included, and checks them all. It lists only
 * the unarchived ones, so a call archived elsewhere hides in its place and shows again when it is restored. A call that
 * falls below the 300th place drops out, archived or not.
 */
export type Home = { rows: Row[]; nextCursor: string | null };
export const capped = (rows: Row[]): Row[] => rows.slice(0, HOME_STATUS_ROWS);
/** When a call was last used: its last session, else when it was made. */
const usedAt = (call: HomeCallDTO): string => call.lastActiveAt ?? call.createdAt;
/**
 * What Home lists: unarchived calls, the ones in use now first, then by last use, newest first. The server pages calls
 * in that same order of last use, so the first page holds the calls used most recently, however old they are.
 */
export const listed = (home: Home): Row[] => home.rows.filter((row) => !row.archived).sort((a, b) => Number(Boolean(b.live)) - Number(Boolean(a.live)) || newestFirst(a, b));
/** How many rows Home shows at first, and how many more each Show more calls adds. A call in use now always shows. */
export const SHOWN_ROWS = 5;
export const shownRows = (rows: Row[], limit: number) => Math.max(limit, rows.filter((row) => row.live).length);
export const rowsOf = (page: HomeDTO): Row[] => page.calls.map((call) => ({ ...call, live: page.live.find((item) => item.spaceId === call.id)?.episode ?? null }));

/** One status answer applied by Space ID: whether each call is archived, its activity, and its live Episode. */
function withStatus(rows: Row[], status: HomeStatusDTO): Row[] {
  const calls = new Map(status.calls.map((call) => [call.id, call]));
  const episodes = new Map(status.live.map((item) => [item.spaceId, item.episode]));
  return rows.map((row) => {
    const live = episodes.get(row.id);
    return { ...row, ...calls.get(row.id), live: live === undefined ? row.live : live };
  });
}

/**
 * Where a call sits in Home's order: most recently used first, then by ID, as the server pages it. The engine writes
 * UTC timestamps with up to nine fraction digits and drops trailing zeros, so with the "Z" removed and a space before
 * the ID, which sorts below every digit, the key compares as a string.
 */
const sortKey = (call: HomeCallDTO): string => `${usedAt(call).slice(0, -1)} ${call.id}`;
export const newestFirst = (a: HomeCallDTO, b: HomeCallDTO) => (sortKey(a) > sortKey(b) ? -1 : 1);

/**
 * Reloads Home from its first page into `rows`, the list it holds, so expanded rows survive: reads on until a row sorts
 * at or past Home's oldest row, up to 300 calls, since calls used since push that depth onto later pages. A call's last
 * use only moves forward, and pages list only unarchived calls, so a held call within the depth read that no page lists
 * is archived, and it stays hidden in place.
 */
export async function replay(rows: Row[], page: HomeDTO): Promise<Home> {
  // Checks move a held row's last use forward in place, so the oldest row may no longer be the last.
  const end = rows.reduce<Row | undefined>((oldest, row) => (oldest === undefined || newestFirst(row, oldest) > 0 ? row : oldest), undefined);
  const deeper = (call: HomeCallDTO | undefined) => end !== undefined && call !== undefined && newestFirst(call, end) < 0;
  let data = page;
  while (data.nextCursor && data.calls.length < HOME_STATUS_ROWS && deeper(data.calls.at(-1))) {
    const older = await readPage("home", { cursor: data.nextCursor });
    data = { calls: [...data.calls, ...older.calls], live: [...data.live, ...older.live], nextCursor: older.nextCursor };
  }
  const last = data.calls.at(-1);
  const onPages = new Set(data.calls.map((call) => call.id));
  const archived = rows.filter((row) => !onPages.has(row.id) && (!data.nextCursor || (last !== undefined && newestFirst(row, last) < 0))).map((row) => ({ ...row, archived: true }));
  return { rows: capped([...rowsOf(data), ...archived].sort(newestFirst)), nextCursor: data.nextCursor };
}

/** One status check: refreshes every held row, and folds in the first page when a call was made elsewhere. */
export async function readHomeStatus(home: Home): Promise<Home> {
  const ids = home.rows.map((row) => row.id);
  const status = await readPage("home-status", { home: "1", ...(ids.length ? { spaceIds: ids.join(",") } : {}) });
  const rows = withStatus(home.rows, status);
  const first = status.first;
  if (!first) return { ...home, rows };
  // Calls made elsewhere are the newest, so they sit above every call Home holds: put the first page's calls above
  // the first one Home knows on top. With no known call on the page (a whole page of new calls), or an unknown call
  // below a known one (a call archived before Home loaded, then restored), reload from this page into the rows
  // this answer just updated.
  const known = new Set(rows.map((row) => row.id));
  const overlap = first.calls.findIndex((call) => known.has(call.id));
  if (overlap < 0 || first.calls.slice(overlap).some((call) => !known.has(call.id))) return replay(rows, first);
  const discovered = rowsOf(first);
  const byId = new Map(discovered.map((row) => [row.id, row]));
  return { ...home, rows: capped([...discovered.slice(0, overlap), ...rows.map((row) => byId.get(row.id) ?? row)]) };
}
