import { describe, expect, it } from "vitest";
import { deltaFixture, eventFixture, snapshotFixture, TEST_FILTER_FINGERPRINT, TEST_REFERENCE } from "./test-fixtures";

describe("episode debugger test fixtures", () => {
  it("keeps event, snapshot, and delta cursors aligned for stream tests", () => {
    const event = eventFixture(12, { name: "media.remote_track" });
    const snapshot = snapshotFixture(12, { summary: { eventCount: 12, operationCount: 0, issueCount: 0, openIssueCount: 0, participantCount: 0 } });
    const delta = deltaFixture(12, event);

    expect(event.cursor).toBe(snapshot.projectedCursor);
    expect(delta.event).toEqual(event);
    expect(delta.reference).toBe(TEST_REFERENCE);
    expect(delta.filterFingerprint).toBe(TEST_FILTER_FINGERPRINT);
  });
});
