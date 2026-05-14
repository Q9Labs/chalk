import { isInvisiblySmallElement } from "@excalidraw/excalidraw";
import type { OrderedExcalidrawElement } from "./types";

const TOMBSTONE_RETENTION_MS = 24 * 60 * 60 * 1000;

export const filterSyncableElements = (elements: readonly OrderedExcalidrawElement[], nowMs: number) =>
  elements.filter((el) => {
    if (el.isDeleted) {
      return el.updated > nowMs - TOMBSTONE_RETENTION_MS;
    }
    return !isInvisiblySmallElement(el);
  });
