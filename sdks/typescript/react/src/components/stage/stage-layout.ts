/**
 * Pure stage geometry. Turns a measured box plus an ordered list of item ids
 * into absolute frames (px), so the renderer never reasons about breakpoints
 * or participant counts. Everything here is deterministic and unit-tested.
 */

export interface StageBox {
  readonly width: number;
  readonly height: number;
}

export type StageRole = "primary" | "strip" | "grid";

export interface StageFrame {
  readonly id: string;
  readonly role: StageRole;
  /** Zero-based page the frame lives on. Primary frames are always page 0. */
  readonly page: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface StageGeometry {
  readonly frames: readonly StageFrame[];
  readonly pageCount: number;
  /** Items shown per page (grid) or strip tiles per strip page (spotlight). */
  readonly perPage: number;
}

export interface GridFitOptions {
  /** Gap between tiles and between pages, px. */
  readonly gap: number;
  /** Tiles narrower than this force a smaller page. */
  readonly minTileWidth: number;
  /** Tiles shorter than this force a smaller page. */
  readonly minTileHeight: number;
  /** Hard cap on tiles per page. */
  readonly maxPerPage: number;
  /** Tiles stretch to fill their cell as long as their aspect (width / height) stays inside these bounds. */
  readonly minAspect: number;
  readonly maxAspect: number;
}

export interface SpotlightFitOptions {
  readonly gap: number;
  /** Strip height as a fraction of the box height, clamped to [minStripHeight, maxStripHeight]. */
  readonly stripRatio: number;
  readonly minStripHeight: number;
  readonly maxStripHeight: number;
  /** Aspect ratio of strip tiles (width / height). */
  readonly stripAspect: number;
}

export const WIDESCREEN = 16 / 9;
/** An arrangement whose tiles cannot fill their cells must beat a filling one by this much area. */
const CLAMPED_AREA_WEIGHT = 0.85;

export const DEFAULT_GRID_OPTIONS: GridFitOptions = { gap: 12, minTileWidth: 160, minTileHeight: 120, maxPerPage: 25, minAspect: 3 / 4, maxAspect: 21 / 9 };
export const DEFAULT_SPOTLIGHT_OPTIONS: SpotlightFitOptions = { gap: 12, stripRatio: 0.18, minStripHeight: 88, maxStripHeight: 168, stripAspect: WIDESCREEN };

export const EMPTY_GEOMETRY: StageGeometry = { frames: [], pageCount: 0, perPage: 0 };

interface Arrangement {
  readonly cols: number;
  readonly rows: number;
  readonly tileWidth: number;
  readonly tileHeight: number;
}

/**
 * Best column count for `count` equal tiles inside `box`, maximising tile area. Tiles take their whole
 * cell so the stage is filled; only when a cell would be absurdly tall or wide is the tile clamped to
 * the aspect bounds and centred in the cell, and such arrangements have to win by a margin.
 */
export function bestArrangement(box: StageBox, count: number, options: Pick<GridFitOptions, "gap" | "minAspect" | "maxAspect">): Arrangement {
  let best: Arrangement = { cols: 1, rows: count, tileWidth: 0, tileHeight: 0 };
  let bestScore = 0;
  for (let cols = 1; cols <= count; cols += 1) {
    const rows = Math.ceil(count / cols);
    const cellWidth = (box.width - options.gap * (cols - 1)) / cols;
    const cellHeight = (box.height - options.gap * (rows - 1)) / rows;
    if (cellWidth <= 0 || cellHeight <= 0) continue;
    const cellAspect = cellWidth / cellHeight;
    const clamped = cellAspect > options.maxAspect || cellAspect < options.minAspect;
    const tileWidth = cellAspect > options.maxAspect ? cellHeight * options.maxAspect : cellWidth;
    const tileHeight = cellAspect < options.minAspect ? cellWidth / options.minAspect : cellHeight;
    const score = tileWidth * tileHeight * (clamped ? CLAMPED_AREA_WEIGHT : 1);
    if (score > bestScore) {
      best = { cols, rows, tileWidth, tileHeight };
      bestScore = score;
    }
  }
  return best;
}

/** Largest page size (≤ maxPerPage) whose tiles still meet `minTileWidth` and `minTileHeight`. */
export function tilesPerPage(box: StageBox, count: number, options: GridFitOptions): number {
  const upper = Math.min(count, Math.max(1, options.maxPerPage));
  for (let size = upper; size > 1; size -= 1) {
    const { tileWidth, tileHeight } = bestArrangement(box, size, options);
    if (tileWidth >= options.minTileWidth && tileHeight >= options.minTileHeight) return size;
  }
  return 1;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Equal tiles that fill the box, centred last row, paged when they would get too small. */
export function fitGrid(box: StageBox, ids: readonly string[], options: GridFitOptions): StageGeometry {
  const count = ids.length;
  if (count === 0) return EMPTY_GEOMETRY;
  if (count === 1) {
    return { frames: [{ id: ids[0]!, role: "grid", page: 0, x: 0, y: 0, width: box.width, height: box.height }], pageCount: 1, perPage: 1 };
  }
  const perPage = tilesPerPage(box, count, options);
  const pageCount = Math.ceil(count / perPage);
  const arrangement = bestArrangement(box, Math.min(count, perPage), options);
  const { cols, tileWidth, tileHeight } = arrangement;
  const pageStride = box.width + options.gap;
  const frames: StageFrame[] = [];
  for (let page = 0; page < pageCount; page += 1) {
    const pageIds = ids.slice(page * perPage, (page + 1) * perPage);
    const rows = Math.ceil(pageIds.length / cols);
    const gridHeight = rows * tileHeight + (rows - 1) * options.gap;
    const offsetY = Math.max(0, (box.height - gridHeight) / 2);
    for (let row = 0; row < rows; row += 1) {
      const rowIds = pageIds.slice(row * cols, (row + 1) * cols);
      const rowWidth = rowIds.length * tileWidth + (rowIds.length - 1) * options.gap;
      const offsetX = Math.max(0, (box.width - rowWidth) / 2);
      rowIds.forEach((id, column) => {
        frames.push({
          id,
          role: "grid",
          page,
          x: round(page * pageStride + offsetX + column * (tileWidth + options.gap)),
          y: round(offsetY + row * (tileHeight + options.gap)),
          width: round(tileWidth),
          height: round(tileHeight),
        });
      });
    }
  }
  return { frames, pageCount, perPage };
}

/** One primary filling the stage above a paged strip of fixed-height tiles. */
export function fitSpotlight(box: StageBox, primaryId: string, stripIds: readonly string[], options: SpotlightFitOptions): StageGeometry {
  if (stripIds.length === 0) {
    return { frames: [{ id: primaryId, role: "primary", page: 0, x: 0, y: 0, width: box.width, height: box.height }], pageCount: 1, perPage: 0 };
  }
  const stripHeight = Math.min(options.maxStripHeight, Math.max(options.minStripHeight, box.height * options.stripRatio));
  const tileWidth = stripHeight * options.stripAspect;
  const perPage = Math.max(1, Math.floor((box.width + options.gap) / (tileWidth + options.gap)));
  const pageCount = Math.ceil(stripIds.length / perPage);
  const primaryHeight = Math.max(0, box.height - stripHeight - options.gap);
  const pageStride = box.width + options.gap;
  const stripY = primaryHeight + options.gap;
  const frames: StageFrame[] = [{ id: primaryId, role: "primary", page: 0, x: 0, y: 0, width: box.width, height: round(primaryHeight) }];
  for (let page = 0; page < pageCount; page += 1) {
    const pageIds = stripIds.slice(page * perPage, (page + 1) * perPage);
    const rowWidth = pageIds.length * tileWidth + (pageIds.length - 1) * options.gap;
    const offsetX = Math.max(0, (box.width - rowWidth) / 2);
    pageIds.forEach((id, column) => {
      frames.push({
        id,
        role: "strip",
        page,
        x: round(page * pageStride + offsetX + column * (tileWidth + options.gap)),
        y: round(stripY),
        width: round(tileWidth),
        height: round(stripHeight),
      });
    });
  }
  return { frames, pageCount, perPage };
}
