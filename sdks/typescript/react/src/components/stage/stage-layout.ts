/** Deterministic geometry shared by the live call and recording projection. */
export interface StageBox { readonly width: number; readonly height: number }
export type StageRole = "primary" | "strip" | "grid";
export interface StageFrame {
  readonly id: string;
  readonly role: StageRole;
  readonly page: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
export interface StageGeometry {
  readonly frames: readonly StageFrame[];
  readonly pageCount: number;
  readonly perPage: number;
  readonly overflowCount?: number;
}
export interface GridFitOptions {
  readonly gap: number;
  readonly minTileWidth: number;
  readonly minTileHeight: number;
  readonly maxPerPage: number;
  readonly minAspect: number;
  readonly maxAspect: number;
}
export interface SpotlightFitOptions {
  readonly gap: number;
  readonly stripRatio: number;
  readonly minStripHeight: number;
  readonly maxStripHeight: number;
  readonly stripAspect: number;
  readonly primaryAspect?: number;
  readonly content?: boolean;
  readonly wideIds?: readonly string[];
  readonly maxPerPage?: number;
}
export const WIDESCREEN = 16 / 9;
export const MORE_TILE_ID = "stage:more";
export const DEFAULT_GRID_OPTIONS: GridFitOptions = { gap: 8, minTileWidth: 150, minTileHeight: 96, maxPerPage: 25, minAspect: .8, maxAspect: 2 };
export const DEFAULT_SPOTLIGHT_OPTIONS: SpotlightFitOptions = { gap: 8, stripRatio: .17, minStripHeight: 104, maxStripHeight: 150, stripAspect: WIDESCREEN };
export const EMPTY_GEOMETRY: StageGeometry = { frames: [], pageCount: 0, perPage: 0 };
const HARD_MIN = .6;
const HARD_MAX = 2.4;
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
interface RowPlan { readonly counts: readonly number[]; readonly height: number; readonly minWidth: number; readonly cost: number }

function rowPlan(box: StageBox, weights: readonly number[], options: GridFitOptions): RowPlan | null {
  const units = weights.reduce((sum, weight) => sum + weight, 0);
  let best: RowPlan | null = null;
  for (let rows = 1; rows <= units; rows += 1) {
    const base = Math.floor(units / rows);
    const counts = Array.from({ length: rows }, (_, index) => base + (index < units % rows ? 1 : 0));
    const height = (box.height - (rows - 1) * options.gap) / rows;
    if (height <= 0) break;
    // A double-width content tile must fit wholly in one row.
    let index = 0;
    let fits = true;
    for (const count of counts) {
      let used = 0;
      while (index < weights.length && used < count) { used += weights[index] ?? 1; index += 1; }
      if (used !== count) { fits = false; break; }
    }
    if (!fits || index !== weights.length) continue;
    let cost = 0;
    let minWidth = Infinity;
    const target = options.minTileWidth === 88 ? 1 : 1.6;
    for (const count of counts) {
      const width = (box.width - (count - 1) * options.gap) / count;
      if (width <= 0) { fits = false; break; }
      minWidth = Math.min(minWidth, width);
      const aspect = width / height;
      const hard = aspect < HARD_MIN ? Math.log(HARD_MIN / aspect) : aspect > HARD_MAX ? Math.log(aspect / HARD_MAX) : 0;
      const soft = aspect < options.minAspect ? Math.log(options.minAspect / aspect) : aspect > options.maxAspect ? Math.log(aspect / options.maxAspect) : 0;
      cost += count * (hard * 60 + soft * 3 + Math.abs(Math.log(aspect / target)));
    }
    cost /= units;
    if (fits && (!best || cost < best.cost)) best = { counts, height, minWidth, cost };
  }
  return best;
}

/** All rows fill their width, including the uneven final row. Overflow is a real +N tile. */
export function fitGrid(box: StageBox, ids: readonly string[], options: GridFitOptions, wideIds: readonly string[] = []): StageGeometry {
  if (!ids.length) return EMPTY_GEOMETRY;
  let keys: readonly string[] = ids;
  let plan: RowPlan | null = null;
  let overflowCount = 0;
  const weight = (id: string): number => wideIds.includes(id) ? 2 : 1;
  for (let count = Math.min(ids.length, Math.max(1, options.maxPerPage)); count >= 1; count -= 1) {
    overflowCount = count < ids.length ? ids.length - count + 1 : 0;
    keys = overflowCount ? [...ids.slice(0, count - 1), MORE_TILE_ID] : ids;
    plan = rowPlan(box, keys.map(weight), options);
    if (plan && ((plan.minWidth >= options.minTileWidth && plan.height >= options.minTileHeight) || count <= (wideIds.includes(ids[0] ?? "") ? 2 : 1))) break;
  }
  if (!plan) return EMPTY_GEOMETRY;
  let height = plan.height;
  for (const count of plan.counts) height = Math.min(height, (box.width - (count - 1) * options.gap) / count / HARD_MIN);
  const offsetY = (box.height - plan.counts.length * height - (plan.counts.length - 1) * options.gap) / 2;
  const frames: StageFrame[] = [];
  let index = 0;
  plan.counts.forEach((count, row) => {
    const unitWidth = Math.min((box.width - (count - 1) * options.gap) / count, height * HARD_MAX);
    let x = (box.width - count * unitWidth - (count - 1) * options.gap) / 2;
    let used = 0;
    while (used < count && index < keys.length) {
      const id = keys[index];
      if (id === undefined) break;
      const units = weight(id);
      const width = unitWidth * units + options.gap * (units - 1);
      frames.push({ id, role: "grid", page: 0, x, y: offsetY + row * (height + options.gap), width, height });
      x += width + options.gap;
      used += units;
      index += 1;
    }
  });
  return { frames, pageCount: 1, perPage: keys.length, overflowCount };
}

function contain(box: StageBox, aspect: number): StageBox {
  const width = Math.min(box.width, box.height * aspect);
  return { width, height: width / aspect };
}

/** Content takes whichever placement gives it more visible area; people justify into the remainder. */
export function fitSpotlight(box: StageBox, primaryId: string, stripIds: readonly string[], options: SpotlightFitOptions): StageGeometry {
  const phone = box.width <= 640;
  const aspect = options.primaryAspect ?? WIDESCREEN;
  if (!stripIds.length) {
    const width = options.content || phone ? box.width : Math.min(box.width * .56, box.height * WIDESCREEN);
    const height = options.content || phone ? box.height : Math.min(box.height, width / (4 / 3));
    return { frames: [{ id: primaryId, role: "primary", page: 0, x: (box.width - width) / 2, y: (box.height - height) / 2, width, height }], pageCount: 1, perPage: 0 };
  }
  if (phone && stripIds.length === 1 && !options.content) {
    return { frames: [{ id: primaryId, role: "primary", page: 0, x: 0, y: 0, ...box }, { id: stripIds[0] ?? "", role: "strip", page: 0, x: box.width - 108, y: 12, width: 96, height: 128 }], pageCount: 1, perPage: 1 };
  }
  const strip = phone ? Math.round(box.height * .3) : clamp(box.height * options.stripRatio, options.minStripHeight, options.maxStripHeight);
  const column = phone && options.content ? 120 : clamp(box.width * .15, 180, 260);
  const belowMain = options.content ? contain({ width: box.width, height: box.height - strip - options.gap }, aspect) : { width: box.width, height: box.height - strip - options.gap };
  const besideMain = options.content ? contain({ width: box.width - column - options.gap, height: box.height }, aspect) : { width: box.width - column - options.gap, height: box.height };
  const beside = options.content ? besideMain.width * besideMain.height > belowMain.width * belowMain.height * 1.005 : !phone && Math.abs(Math.log(besideMain.width / besideMain.height / WIDESCREEN)) < Math.abs(Math.log(belowMain.width / belowMain.height / WIDESCREEN));
  const main = { width: beside ? besideMain.width : box.width, height: beside ? box.height : belowMain.height };
  const remaining = { width: beside ? box.width - main.width - options.gap : box.width, height: beside ? box.height : box.height - main.height - options.gap };
  const people = fitGrid(remaining, stripIds, { ...DEFAULT_GRID_OPTIONS, minTileWidth: phone ? 88 : 150, minTileHeight: phone ? 72 : 96, maxPerPage: options.maxPerPage ?? 25 }, options.wideIds);
  return {
    ...people,
    frames: [{ id: primaryId, role: "primary", page: 0, x: 0, y: 0, ...main }, ...people.frames.map(frame => ({ ...frame, role: "strip" as const, x: frame.x + (beside ? main.width + options.gap : 0), y: frame.y + (beside ? 0 : main.height + options.gap) }))],
  };
}
