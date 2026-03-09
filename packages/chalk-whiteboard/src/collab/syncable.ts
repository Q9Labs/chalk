import { isInvisiblySmallElement } from "@excalidraw/excalidraw";

const TOMBSTONE_RETENTION_MS = 24 * 60 * 60 * 1000;

export const filterSyncableElements = <T extends { isDeleted?: boolean; updated?: number }>(elements: readonly T[], nowMs: number) =>
  elements.filter((el) => {
    if (el.isDeleted) {
      const updated = typeof el.updated === "number" ? el.updated : 0;
      return updated > nowMs - TOMBSTONE_RETENTION_MS;
    }
    return !isInvisiblySmallElement(el as any);
  });
