import { isInvisiblySmallElement } from "@excalidraw/excalidraw";
import type { OrderedExcalidrawElement } from "./types.js";

export const filterSyncableElements = (elements: readonly OrderedExcalidrawElement[]) =>
  elements.filter((el) => {
    if (el.isDeleted) return true;
    return !isInvisiblySmallElement(el);
  });
