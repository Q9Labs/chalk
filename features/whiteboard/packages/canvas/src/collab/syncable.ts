import { isInvisiblySmallElement } from "@excalidraw/excalidraw";
import type { OrderedExcalidrawElement } from "./types";

export const filterSyncableElements = (elements: readonly OrderedExcalidrawElement[]) =>
  elements.filter((el) => {
    if (el.isDeleted) return true;
    return !isInvisiblySmallElement(el);
  });

export const remoteImageFileIds = (elements: readonly OrderedExcalidrawElement[]): string[] => elements.flatMap((element) => (element.type === "image" && element.fileId ? [element.fileId] : []));

export const retainStoredImages = (elements: readonly OrderedExcalidrawElement[], storedFileIds: ReadonlySet<string>) => elements.filter((element) => element.type !== "image" || (element.fileId !== null && storedFileIds.has(element.fileId)));
