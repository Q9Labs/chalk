import { describe, expect, it } from "vitest";
import { PAGE_ROWS, type SessionListDTO, type SessionRowDTO } from "./contracts";
import { appendPage, bounds, dayValue, mergeFirstPage, recordingBadge, recordingsQueryOf, refreshable, sessionsQueryOf, timeInCalls, transcriptBadge } from "./lists";
import { parseRecordingsSearch, parseSessionsSearch } from "./search";

const now = new Date(2026, 10, 10, 15, 30);

describe("list ranges", () => {
  it("covers whole days in the viewer's time zone, ending at the end of today", () => {
    expect(dayValue(bounds({ range: "today" }, now).from)).toBe("2026-11-10");
    expect(dayValue(bounds({ range: "7d" }, now).from)).toBe("2026-11-04");
    expect(dayValue(bounds({ range: "30d" }, now).from)).toBe("2026-10-12");
    expect(dayValue(bounds({ range: "month" }, now).from)).toBe("2026-11-01");
    const week = bounds({ range: "7d" }, now);
    expect(dayValue(week.to)).toBe("2026-11-10");
    expect(week.to.getHours()).toBe(23);
    expect(week.span).toBe("4 Nov – 10 Nov");
  });

  it("is the last 30 days with no range, and for a custom range that is missing or backwards", () => {
    expect(bounds({}, now).label).toBe("Last 30 days");
    expect(bounds({ range: "custom" }, now).kind).toBe("30d");
    expect(bounds({ range: "custom", from: "2026-11-09", to: "2026-11-01" }, now).kind).toBe("30d");
  });

  it("takes a custom range as written", () => {
    const range = bounds({ range: "custom", from: "2026-10-01", to: "2026-10-31" }, now);
    expect(range.label).toBe("1 Oct – 31 Oct");
    expect(dayValue(range.from)).toBe("2026-10-01");
    expect(dayValue(range.to)).toBe("2026-10-31");
  });

  it("builds the API query from the address, with the same instants for every page of one list", () => {
    const query = sessionsQueryOf(parseSessionsSearch({ range: "7d", q: " design ", show: "none" }), now);
    expect(query).toMatchObject({ q: "design", show: "none" });
    expect(sessionsQueryOf(parseSessionsSearch({ range: "7d" }), new Date(2026, 10, 10, 9)).to).toBe(query.to);
    expect(recordingsQueryOf(parseRecordingsSearch({ status: "failed" }), now).status).toBe("failed");
  });
});

describe("list addresses", () => {
  it("drops a value that isn't one the page offers, rather than failing the page", () => {
    expect(parseSessionsSearch({ show: "everything", range: "forever", q: "", spaceId: "nope", from: "yesterday" })).toEqual({});
    expect(parseRecordingsSearch({ status: "ready", play: "also-not-an-id" })).toEqual({ status: "ready" });
  });
});

describe("what a row says", () => {
  it("names the video and the transcript", () => {
    expect(recordingBadge(null).label).toBe("No recording");
    expect(recordingBadge("play").label).toBe("Recording");
    expect(recordingBadge("preparing")).toMatchObject({ label: "Processing", icon: "spin" });
    expect(recordingBadge("preparable").label).toBe("Not prepared");
    expect(recordingBadge("retryable").tone).toBe("bad");
    expect(transcriptBadge("ready", "play").label).toBe("Transcript");
    expect(transcriptBadge("none", "preparable").label).toBe("None yet");
    expect(transcriptBadge("none", "capture_failed").label).toBe("–");
    expect(transcriptBadge("none", null).label).toBe("–");
  });

  it("splits time in calls into hours and minutes", () => {
    expect(timeInCalls(21 * 3600 + 5 * 60)).toEqual({ hours: 21, minutes: 5 });
    expect(timeInCalls(0)).toBeNull();
  });
});

const row = (id: number, startedAt: string, video: NonNullable<SessionRowDTO["recording"]>["video"] = "play"): SessionRowDTO => ({
  spaceId: "space",
  callName: "Call",
  episode: { id: `e${id}`, status: "ended", startedAt, endedAt: startedAt },
  participantCount: 2,
  recording: { id: `r${id}`, video, failureMessage: null },
  transcript: "none",
  transcriptIds: [],
});
const list = (rows: SessionRowDTO[], nextCursor: string | null): SessionListDTO => ({ rows, totals: { sessions: rows.length, seconds: 0, recorded: rows.length, transcripts: 0, video: { ready: 0, processing: 0, prepare: 0, failed: 0, expired: 0 } }, calls: [], nextCursor, truncated: false });

describe("lists that grow and refresh", () => {
  const day = (n: number) => `2026-11-0${n}T10:00:00.000Z`;

  it("adds a page without repeating a row", () => {
    const joined = appendPage(list([row(3, day(3)), row(2, day(2))], "c1"), list([row(2, day(2)), row(1, day(1))], null));
    expect(joined.rows.map((item) => item.episode.id)).toEqual(["e3", "e2", "e1"]);
    expect(joined.nextCursor).toBeNull();
  });

  it("a first page read again updates its rows and drops the ones that stopped matching", () => {
    const current = list([row(5, day(5), "preparing"), row(4, day(4)), row(3, day(3)), row(2, day(2))], "c2");
    const fresh = list([row(4, day(4)), row(3, day(3), "preparable")], "c9");
    const merged = mergeFirstPage(current, fresh);
    expect(merged.rows.map((item) => [item.episode.id, item.recording?.video])).toEqual([
      ["e4", "play"],
      ["e3", "preparable"],
      ["e2", "play"],
    ]);
    expect(merged.nextCursor).toBe("c2");
  });

  it("takes the new cursor when no later page is on screen", () => {
    const merged = mergeFirstPage(list([row(2, day(2))], "old"), list([row(3, day(3)), row(2, day(2))], null));
    expect(merged.rows).toHaveLength(2);
    expect(merged.nextCursor).toBeNull();
  });

  it("a poll can only change the first page, so older loaded rows are not watched", () => {
    const rows = Array.from({ length: PAGE_ROWS + 2 }, (_, index) => row(index, day(5)));
    expect(refreshable(list(rows, null))).toEqual(rows.slice(0, PAGE_ROWS));
  });
});
