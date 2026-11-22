import { isInvisiblySmallElement, restoreElements } from "@excalidraw/excalidraw";
import { compareElementOrder } from "./order";
import type { ExcalidrawElement, OrderedExcalidrawElement } from "./types";

export const filterSyncableElements = (elements: readonly OrderedExcalidrawElement[]) =>
  elements.filter((el) => {
    if (el.isDeleted) return true;
    return !isInvisiblySmallElement(el);
  });

export const remoteImageFileIds = (elements: readonly OrderedExcalidrawElement[]): string[] => elements.flatMap((element) => (element.type === "image" && element.fileId ? [element.fileId] : []));

export const retainStoredImages = (elements: readonly OrderedExcalidrawElement[], storedFileIds: ReadonlySet<string>) => elements.filter((element) => element.type !== "image" || (element.fileId !== null && storedFileIds.has(element.fileId)));

export function restoreRemoteElements(elements: readonly ExcalidrawElement[]) {
  // Excalidraw takes the order of this list as the order of the elements and rewrites every order key that
  // disagrees with it. Sync lists a board by order key in its database's collation, not in the keys' own order.
  const remoteElements = [...elements].sort(compareElementOrder);
  const received = new Map(remoteElements.map((element) => [element.id, element]));
  // Excalidraw's restore deletes an empty text and bumps its version. A peer's undone text is empty but live, and
  // a deleted copy here would be as new as the peer's Redo, so the Redo could lose the tie. Keep what arrived.
  return restoreElements(remoteElements, null).map((element) => {
    const remote = received.get(element.id);
    return remote && !remote.isDeleted && element.isDeleted ? { ...element, isDeleted: false, version: remote.version, versionNonce: remote.versionNonce } : element;
  });
}
