import { describe, expect, it, vi } from "vitest";

vi.mock("@excalidraw/excalidraw", () => ({
  isInvisiblySmallElement: (element: { width?: number; height?: number }) => element.width === 0 || element.height === 0,
}));

import { filterSyncableElements } from "./syncable";

describe("filterSyncableElements", () => {
  it("keeps visible elements and recent tombstones only", () => {
    const nowMs = Date.UTC(2026, 5, 14);
    const visible = { id: "visible", isDeleted: false, updated: nowMs, width: 12, height: 12 };
    const invisible = { id: "invisible", isDeleted: false, updated: nowMs, width: 0, height: 12 };
    const recentTombstone = { id: "recent", isDeleted: true, updated: nowMs - 1000, width: 0, height: 0 };
    const staleTombstone = { id: "stale", isDeleted: true, updated: nowMs - 25 * 60 * 60 * 1000, width: 10, height: 10 };

    expect(filterSyncableElements([visible, invisible, recentTombstone, staleTombstone] as never, nowMs)).toEqual([visible, recentTombstone]);
  });
});
