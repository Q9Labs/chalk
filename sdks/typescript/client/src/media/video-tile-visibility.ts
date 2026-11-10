import type { VideoRenderSize } from "./video-render-size";

/** How long the UI gets to report a new video publication before it is pulled as if nobody reported. */
export const UNREPORTED_TILE_WAIT_MS = 250;
/** On the join's first pull, this many unreported videos skip the report wait: one screen of tiles, so a big room still waits. */
export const JOIN_UNREPORTED_VIDEO_LIMIT = 4;
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
  readonly #unreportedWaitMs: number;
  #pageHiddenSince: number | undefined;

  constructor(pageHidden: boolean, now: number, unreportedWaitMs: number) {
    this.#pageHiddenSince = pageHidden ? now : undefined;
    this.#unreportedWaitMs = unreportedWaitMs;
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
   * An unreported publication waits briefly for its report and is then pulled, so a UI that never reports keeps every
   * video. A hidden one is not pulled, and a pulled one that goes off screen is closed after a debounce. On the join's
   * first pull the UI has not mounted its tiles yet, so the first few unreported videos go out with the audio at once.
   */
  select(now: number, publicationIds: readonly string[], pulled: ReadonlySet<string>, joining = false): VideoTileSelection {
    this.#list(now, publicationIds);
    const wanted = new Set<string>();
    let wakeAt: number | undefined;
    let immediate = joining ? JOIN_UNREPORTED_VIDEO_LIMIT : 0;
    for (const id of publicationIds) {
      const skipsWait = !reports.has(id) && immediate > 0;
      if (skipsWait) immediate--;
      const choice = skipsWait ? { wanted: true } : this.#choose(id, now, pulled.has(id));
      if (choice.wanted) wanted.add(id);
      if (choice.until !== undefined) wakeAt = Math.min(wakeAt ?? choice.until, choice.until);
    }
    return { wanted, wakeAt };
  }

  #list(now: number, publicationIds: readonly string[]): void {
    const listed = new Set(publicationIds);
    for (const id of this.#firstListed.keys()) if (!listed.has(id)) this.#firstListed.delete(id);
    for (const id of publicationIds) if (!this.#firstListed.has(id)) this.#firstListed.set(id, now);
  }

  /** Whether to pull one video now, and when that answer next changes on its own. */
  #choose(id: string, now: number, pulled: boolean): { readonly wanted: boolean; readonly until?: number } {
    const report = reports.get(id);
    if (!report) {
      if (pulled) return { wanted: true };
      const due = this.#firstListed.get(id)! + this.#unreportedWaitMs;
      return now >= due ? { wanted: true } : { wanted: false, until: due };
    }
    const closeAt = this.#closeAt(report);
    if (closeAt === undefined) return { wanted: true };
    return pulled && now < closeAt ? { wanted: true, until: closeAt } : { wanted: false };
  }

  #closeAt(report: TileReport): number | undefined {
    if (report.size === null) return report.since + HIDDEN_TILE_CLOSE_MS;
    return this.#pageHiddenSince === undefined ? undefined : this.#pageHiddenSince + HIDDEN_PAGE_CLOSE_MS;
  }
}
