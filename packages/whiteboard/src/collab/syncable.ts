import { isInvisiblySmallElement } from "@excalidraw/excalidraw";
import type { OrderedExcalidrawElement } from "./types";

export const filterSyncableElements = (elements: readonly OrderedExcalidrawElement[]) =>
  elements.filter((el) => {
    if (el.isDeleted) return true;
    return !isInvisiblySmallElement(el);
  });
