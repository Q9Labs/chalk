import { describe, expect, it } from "vitest";

import type { MeetingEndData } from "../../components/full/video-conference/types";
import { MEETING_END_SUMMARY_STORAGE_KEY, buildMeetingEndSummary, clearMeetingEndSummary, consumeMeetingEndSummary, readMeetingEndSummary, writeMeetingEndSummary, writeMeetingEndSummaryFromData } from "../../utils/meetingEndSummary";

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();

  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? (store.get(key) ?? null) : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  };
}

function createMeetingEndData(overrides: Partial<MeetingEndData> = {}): MeetingEndData {
  return {
    roomId: "room-123",
    duration: 320,
    transcripts: [],
    recordingId: null,
    participantCount: 5,
    totalParticipants: 8,
    participants: [],
    hostId: "host-1",
    startedAt: new Date("2026-04-14T10:00:00.000Z"),
    endedAt: new Date("2026-04-14T10:05:20.000Z"),
    stats: {
      chatMessageCount: 12,
      reactionCount: 3,
      handRaiseCount: 2,
      screenShareCount: 1,
      whiteboardOpened: true,
      recordingDuration: 300,
    },
    ...overrides,
  };
}

describe("meetingEndSummary", () => {
  it("builds a typed meeting summary from meeting end data", () => {
    const summary = buildMeetingEndSummary(createMeetingEndData(), { roomName: "Daily Sync" });

    expect(summary).toMatchObject({
      roomId: "room-123",
      roomName: "Daily Sync",
      durationSeconds: 320,
      participantCount: 5,
      totalParticipants: 8,
      hostId: "host-1",
      startedAtMs: Date.parse("2026-04-14T10:00:00.000Z"),
      endedAtMs: Date.parse("2026-04-14T10:05:20.000Z"),
      stats: {
        chatMessageCount: 12,
        reactionCount: 3,
      },
    });
  });

  it("writes and reads summary payloads through storage", () => {
    const storage = createMemoryStorage();
    const envelope = writeMeetingEndSummaryFromData(createMeetingEndData(), {
      storage,
      nowMs: 1000,
      ttlMs: 5000,
      roomName: "All Hands",
    });

    expect(envelope).not.toBeNull();

    const summary = readMeetingEndSummary({ storage, nowMs: 2000 });
    expect(summary).toMatchObject({
      roomId: "room-123",
      roomName: "All Hands",
      durationSeconds: 320,
      participantCount: 5,
    });
  });

  it("enforces room-safe reads when roomId is provided", () => {
    const storage = createMemoryStorage();
    writeMeetingEndSummaryFromData(createMeetingEndData({ roomId: "room-a" }), {
      storage,
      nowMs: 1000,
      ttlMs: 5000,
    });

    expect(readMeetingEndSummary({ storage, roomId: "room-b", nowMs: 1500 })).toBeNull();
    expect(readMeetingEndSummary({ storage, roomId: "room-a", nowMs: 1500 })?.roomId).toBe("room-a");
  });

  it("expires stale payloads and clears storage", () => {
    const storage = createMemoryStorage();
    const summary = buildMeetingEndSummary(createMeetingEndData());

    writeMeetingEndSummary(summary, {
      storage,
      nowMs: 10_000,
      ttlMs: 1000,
    });

    expect(readMeetingEndSummary({ storage, nowMs: 11_001 })).toBeNull();
    expect(storage.getItem(MEETING_END_SUMMARY_STORAGE_KEY)).toBeNull();
  });

  it("consumes summary once and clears the handoff", () => {
    const storage = createMemoryStorage();
    writeMeetingEndSummaryFromData(createMeetingEndData(), {
      storage,
      nowMs: 500,
      ttlMs: 10_000,
    });

    const firstRead = consumeMeetingEndSummary({ storage, nowMs: 1000 });
    const secondRead = consumeMeetingEndSummary({ storage, nowMs: 1000 });

    expect(firstRead?.roomId).toBe("room-123");
    expect(secondRead).toBeNull();
  });

  it("clears malformed payloads to avoid stale leakage", () => {
    const storage = createMemoryStorage();
    storage.setItem(MEETING_END_SUMMARY_STORAGE_KEY, '{"bad":true}');

    expect(readMeetingEndSummary({ storage, nowMs: 1000 })).toBeNull();
    expect(storage.getItem(MEETING_END_SUMMARY_STORAGE_KEY)).toBeNull();
  });

  it("supports explicit clear helper", () => {
    const storage = createMemoryStorage();
    writeMeetingEndSummaryFromData(createMeetingEndData(), {
      storage,
      nowMs: 1000,
      ttlMs: 10_000,
    });

    clearMeetingEndSummary({ storage });

    expect(readMeetingEndSummary({ storage, nowMs: 1001 })).toBeNull();
  });
});
