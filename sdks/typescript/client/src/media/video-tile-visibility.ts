import type { VideoRenderSize } from "./video-render-size";

/** How long a UI that reports tiles gets to report a new publication before it is pulled as if nobody reported. */
export const UNREPORTED_TILE_WAIT_MS = 250;
/** A tile that leaves the screen keeps its video this long, so scrolling straight back costs no re-pull. */
export const HIDDEN_TILE_CLOSE_MS = 5000;
/** A hidden tab keeps its video this long, so a quick look at another tab costs no re-pull. */
export const HIDDEN_PAGE_CLOSE_MS = 15_000;
// Publication IDs are never reused, so old reports only cost memory; keep the newest.
const MAX_REPORTS = 256;

type TileReport = { readonly size: VideoRenderSize | null; readonly since: number };
const reports = new Map<string, TileReport>();
const listeners = new Set<() => void>();

/**
 * Tells the media client whether the tile for a remote camera or screen publication is on screen, and how large
 * in device pixels. Pass null when it leaves the screen: the SDK then stops pulling that video and keeps audio.
 * It works before the video track exists and sends nothing to the server.
 */
export function setVideoTileVisibility(publicationId: string, size: VideoRenderSize | null): void {
  const next = size && size.width > 0 && size.height > 0 ? size : null;
  const previous = reports.get(publicationId);
  const flipped = !previous || (previous.size === null) !== (next === null);
  reports.delete(publicationId);
  reports.set(publicationId, { size: next, since: flipped ? Date.now() : previous.since });
  if (reports.size > MAX_REPORTS) reports.delete(reports.keys().next().value!);
  if (flipped) for (const listener of listeners) listener();
}

export type VideoTileSelection = {
  /** Remote video publications to keep or start pulling. */
  readonly wanted: ReadonlySet<string>;
  /** When the selection next changes without a new report, if it will. */
  readonly wakeAt: number | undefined;
};

/** One per media client: picks the remote videos to pull from what the UI reports. */
export class VideoTileSubscriptions {
  readonly #firstListed = new Map<string, number>();
  #pageHiddenSince: number | undefined;
  #reporting = false;

  constructor(pageHidden: boolean, now: number) {
    this.#pageHiddenSince = pageHidden ? now : undefined;
  }

  /** Calls the listener when a tile appears, leaves the screen, or is first reported. */
  observe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  page(hidden: boolean, now: number): void {
    this.#pageHiddenSince = hidden ? (this.#pageHiddenSince ?? now) : undefined;
  }

  /**
   * A UI that never reports keeps every video. Once it reports any listed publication, an unreported one waits briefly
   * for its report, a hidden one is not pulled, and a pulled one that goes off screen is closed after a debounce.
   */
  select(now: number, publicationIds: readonly string[], pulled: ReadonlySet<string>): VideoTileSelection {
    const listed = new Set(publicationIds);
    for (const id of this.#firstListed.keys()) if (!listed.has(id)) this.#firstListed.delete(id);
    for (const id of publicationIds) if (!this.#firstListed.has(id)) this.#firstListed.set(id, now);
    this.#reporting ||= publicationIds.some((id) => reports.has(id));
    if (!this.#reporting) return { wanted: listed, wakeAt: undefined };
    const wanted = new Set<string>();
    let wakeAt: number | undefined;
    const keepUntil = (id: string, at: number) => {
      if (now >= at) return;
      wanted.add(id);
      wakeAt = Math.min(wakeAt ?? at, at);
    };
    for (const id of publicationIds) {
      const report = reports.get(id);
      if (!report) {
        const due = this.#firstListed.get(id)! + UNREPORTED_TILE_WAIT_MS;
        if (now >= due) wanted.add(id);
        else wakeAt = Math.min(wakeAt ?? due, due);
        continue;
      }
      const closeAt = report.size === null ? report.since + HIDDEN_TILE_CLOSE_MS : this.#pageHiddenSince === undefined ? undefined : this.#pageHiddenSince + HIDDEN_PAGE_CLOSE_MS;
      if (closeAt === undefined) wanted.add(id);
      else if (pulled.has(id)) keepUntil(id, closeAt);
    }
    return { wanted, wakeAt };
  }
}
