import { STAGE_GAP as G } from "../frame/regions";
import type { Frame } from "../motion/MovingFrame";

/** What a tile shows: one person, the shared screen or board, or the "+N" tile that opens People. */
export type Slot = { readonly kind: "person"; readonly id: string } | { readonly kind: "content" };

export type StageItem =
  | { readonly kind: "person"; readonly id: string; readonly frame: Frame; readonly big: boolean; readonly float: boolean }
  /** `inner` is the shared content's box inside the tile, letterboxed to its aspect. */
  | { readonly kind: "content"; readonly frame: Frame; readonly inner: Frame; readonly mini: boolean }
  | { readonly kind: "more"; readonly frame: Frame; readonly count: number };

export type StageContent = { readonly kind: "screen" | "board"; /** Width over height; null fills the tile. */ readonly aspect: number | null };

export type StageInput = {
  readonly stage: Frame;
  /** Portrait or landscape phone. The iPad uses the phone layout today. */
  readonly portrait: boolean;
  readonly layout: "spotlight" | "grid";
  /** Everyone in stage order, you included. */
  readonly order: readonly string[];
  /** The person Spotlight shows big when nobody is pinned. */
  readonly spot: string | null;
  readonly pinned: string | null;
  readonly content: StageContent | null;
};

type Placed = { readonly key: Slot | "more"; readonly frame: Frame; readonly more?: number };
type Rows = { readonly placed: readonly Placed[] };
type JustifyOptions = { readonly t: number; readonly minW: number; readonly minH: number };

const SOFT = [0.8, 2] as const;
const HARD = [0.6, 2.4] as const;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const area = (frame: Frame) => frame.width * frame.height;

/** The mockup's `contain`: the largest box of `aspect` centred in `box`. */
export function contain(box: Frame, aspect: number | null): Frame {
  if (!aspect) return box;
  let width = box.width;
  let height = width / aspect;
  if (height > box.height) {
    height = box.height;
    width = height * aspect;
  }
  return { x: box.x + (box.width - width) / 2, y: box.y + (box.height - height) / 2, width, height };
}

/** The mockup's `jo()`: the target aspect and smallest tile per arrangement. */
function justifyOptions(portrait: boolean): JustifyOptions {
  return portrait ? { t: 1, minW: 88, minH: 72 } : { t: 1.5, minW: 100, minH: 64 };
}

/**
 * The mockup's `jplan`: pick the row count, spread `units` so rows differ by at most one, and
 * score each plan by how far its tiles stray from the aspect bounds and the target aspect.
 */
function justifyPlan(box: Frame, units: number, options: JustifyOptions, firstRowTwo: boolean) {
  let best: { counts: number[]; height: number; cost: number; minWidth: number } | null = null;
  for (let rows = 1; rows <= units; rows++) {
    const base = Math.floor(units / rows);
    const extra = units % rows;
    if (!base) break;
    const counts = Array.from({ length: rows }, (_, index) => base + (index < extra ? 1 : 0));
    if (firstRowTwo && (counts[0] ?? 0) < 2) continue;
    const height = (box.height - (rows - 1) * G) / rows;
    if (height <= 0) break;
    let cost = 0;
    let minWidth = Infinity;
    for (const count of counts) {
      const width = (box.width - (count - 1) * G) / count;
      const aspect = width / height;
      minWidth = Math.min(minWidth, width);
      const hard = aspect < HARD[0] ? Math.log(HARD[0] / aspect) : aspect > HARD[1] ? Math.log(aspect / HARD[1]) : 0;
      const soft = aspect < SOFT[0] ? Math.log(SOFT[0] / aspect) : aspect > SOFT[1] ? Math.log(aspect / SOFT[1]) : 0;
      cost += count * (hard * 60 + soft * 3 + Math.abs(Math.log(aspect / options.t)));
    }
    cost /= units;
    if (!best || cost < best.cost) best = { counts, height, cost, minWidth };
  }
  return best;
}

/**
 * The mockup's `jrows`: justified rows that fill the box with no gaps. Shared content takes a
 * double tile. When tiles would get smaller than the minimum, the last one becomes "+N".
 */
function justifiedRows(box: Frame, list: readonly Slot[], options: JustifyOptions): Rows {
  const weight = (key: Slot | "more") => (key !== "more" && key.kind === "content" ? 2 : 1);
  const contentFirst = list[0]?.kind === "content";
  const total = list.length;
  let keys: readonly (Slot | "more")[] = list;
  let plan: ReturnType<typeof justifyPlan> = null;
  for (let kept = total; kept >= 1; kept--) {
    keys = kept === total ? list : [...list.slice(0, kept - 1), "more"];
    plan = justifyPlan(
      box,
      keys.reduce((sum, key) => sum + weight(key), 0),
      options,
      contentFirst,
    );
    if ((plan && plan.minWidth >= options.minW && plan.height >= options.minH) || kept <= (contentFirst ? 2 : 1)) break;
  }
  if (!plan) return { placed: [] };
  let height = plan.height;
  for (const count of plan.counts) {
    const width = (box.width - (count - 1) * G) / count;
    if (width / height < HARD[0]) height = Math.min(height, width / HARD[0]);
  }
  const top = box.y + (box.height - plan.counts.length * height - (plan.counts.length - 1) * G) / 2;
  const placed: Placed[] = [];
  let index = 0;
  plan.counts.forEach((count, row) => {
    let unit = (box.width - (count - 1) * G) / count;
    if (unit / height > HARD[1]) unit = height * HARD[1];
    let x = box.x + (box.width - count * unit - (count - 1) * G) / 2;
    let used = 0;
    while (used < count && index < keys.length) {
      const key = keys[index];
      if (key === undefined) break;
      const units = weight(key);
      const frame = { x, y: top + row * (height + G), width: unit * units + G * (units - 1), height };
      placed.push(key === "more" ? { key, frame, more: total - keys.length + 1 } : { key, frame });
      x += frame.width + G;
      used += units;
      index++;
    }
  });
  return { placed };
}

/** The mockup's `fitGrid` and `fill` for a single tile: the largest box within the aspect bounds, centred. */
function fillOne(box: Frame, aspect: { readonly min: number; readonly max: number; readonly cap: number }): Frame {
  let width = box.width;
  let height = box.height;
  if (width / height > aspect.max) width = height * aspect.max;
  else if (width / height < aspect.min) height = width / aspect.min;
  if (aspect.cap && width > aspect.cap) {
    height *= aspect.cap / width;
    width = aspect.cap;
  }
  return { x: box.x + (box.width - width) / 2, y: box.y + (box.height - height) / 2, width, height };
}

/** Lays out the stage as the mockup's `layout()` does for a phone call. */
export function stageLayout(input: StageInput): readonly StageItem[] {
  const { stage, portrait, content } = input;
  if (input.layout === "grid") {
    const rows = justifiedRows(stage, content ? [{ kind: "content" }, ...people(input.order)] : people(input.order), justifyOptions(portrait));
    return toItems(rows.placed, content, { miniContent: true });
  }
  if (content && input.pinned !== null) return spotlightPeople(input, [{ kind: "content" }, ...people(input.order)]);
  return content ? spotlightContent(input, content) : spotlightPeople(input, people(input.order));
}

function people(order: readonly string[]): Slot[] {
  return order.map((id) => ({ kind: "person", id }));
}

/** The mockup's `spotContent`: the share gets the larger of below or beside, people fill the rest. */
function spotlightContent(input: StageInput, content: StageContent): readonly StageItem[] {
  const { stage, portrait } = input;
  const peopleMin = portrait ? (content.kind === "board" ? clamp(Math.round(stage.height * 0.17), 96, 120) : Math.round(stage.height * 0.3)) : clamp(stage.height * 0.17, 104, 150);
  const contentMin = portrait ? 120 : clamp(stage.width * 0.15, 180, 260);
  const belowBox = contain({ ...stage, height: stage.height - peopleMin - G }, content.aspect);
  const below = { tile: { ...stage, height: belowBox.height }, rest: { x: stage.x, y: stage.y + belowBox.height + G, width: stage.width, height: stage.height - belowBox.height - G }, area: area(belowBox) };
  const besideBox = contain({ ...stage, width: stage.width - contentMin - G }, content.aspect);
  const beside = { tile: { ...stage, width: besideBox.width }, rest: { x: stage.x + besideBox.width + G, y: stage.y, width: stage.width - besideBox.width - G, height: stage.height }, area: area(besideBox) };
  const best = beside.area > below.area * 1.005 ? beside : below;
  const rows = justifiedRows(best.rest, people(input.order), justifyOptions(portrait));
  const tile: StageItem = { kind: "content", frame: best.tile, inner: contain({ x: 0, y: 0, width: best.tile.width, height: best.tile.height }, content.aspect), mini: false };
  return [tile, ...toItems(rows.placed, content, { miniContent: true })];
}

/** The mockup's `spotPeople`: one person big, everyone else in rows below (or beside, in landscape). */
function spotlightPeople(input: StageInput, list: readonly Slot[]): readonly StageItem[] {
  const { stage, portrait, content, pinned, spot } = input;
  const ids = list.flatMap((slot) => (slot.kind === "person" ? [slot.id] : []));
  const main = content ? pinned : pinned !== null && ids.includes(pinned) ? pinned : spot !== null && ids.includes(spot) ? spot : (ids[0] ?? null);
  if (main === null) return [];
  const rest = list.filter((slot) => slot.kind !== "person" || slot.id !== main);
  const first = rest[0];
  if (!first) return [{ kind: "person", id: main, frame: fillOne(stage, { min: portrait ? 0.4 : 4 / 3, max: 16 / 9, cap: portrait ? 0 : stage.width * 0.56 }), big: false, float: false }];
  if (rest.length === 1) {
    const size = portrait ? { width: 96, height: 128 } : { width: 132, height: 96 };
    const y = portrait ? stage.y + 12 : stage.y + stage.height - size.height - 12;
    const floating = { x: stage.x + stage.width - size.width - 12, y, ...size };
    return [{ kind: "person", id: main, frame: stage, big: false, float: false }, ...toItems([{ key: first, frame: floating }], content, { miniContent: true, float: true })];
  }
  const peopleMin = portrait ? Math.round(stage.height * 0.3) : clamp(stage.height * 0.17, 104, 150);
  const sideMin = clamp(stage.width * 0.15, 180, 260);
  const off = (frame: Frame) => Math.abs(Math.log(frame.width / frame.height / (16 / 9)));
  const below = { main: { ...stage, height: stage.height - peopleMin - G }, rest: { x: stage.x, y: stage.y + stage.height - peopleMin, width: stage.width, height: peopleMin } };
  const beside = { main: { ...stage, width: stage.width - sideMin - G }, rest: { x: stage.x + stage.width - sideMin, y: stage.y, width: sideMin, height: stage.height } };
  const chosen = portrait || off(below.main) <= off(beside.main) ? below : beside;
  return [{ kind: "person", id: main, frame: chosen.main, big: true, float: false }, ...toItems(justifiedRows(chosen.rest, rest, justifyOptions(portrait)).placed, content, { miniContent: true })];
}

function toItems(placed: readonly Placed[], content: StageContent | null, options: { readonly miniContent: boolean; readonly float?: boolean }): StageItem[] {
  return placed.map(({ key, frame, more }): StageItem => {
    if (key === "more") return { kind: "more", frame, count: more ?? 0 };
    if (key.kind === "person") return { kind: "person", id: key.id, frame, big: false, float: options.float ?? false };
    return { kind: "content", frame, inner: contain({ x: 0, y: 0, width: frame.width, height: frame.height }, content?.aspect ?? null), mini: options.miniContent };
  });
}

export type StageOrder = { readonly order: readonly string[]; readonly spot: string | null };

/**
 * Keeps the stage order stable as people come and go, as the mockup's `syncOrder` and
 * `nextSpeaker` do: leavers drop out, newcomers join the end, and when someone else starts
 * speaking they swap places with the person in the spotlight, so only those two tiles move.
 */
export function nextStageOrder(previous: StageOrder, present: readonly string[], selfId: string | null, speaker: string | null): StageOrder {
  const order = previous.order.filter((id) => present.includes(id));
  for (const id of present) if (!order.includes(id)) order.push(id);
  let spot = previous.spot !== null && present.includes(previous.spot) ? previous.spot : (present.find((id) => id !== selfId) ?? present[0] ?? null);
  if (speaker !== null && speaker !== selfId && speaker !== spot && present.includes(speaker)) {
    const from = spot === null ? -1 : order.indexOf(spot);
    const to = order.indexOf(speaker);
    if (from >= 0 && to >= 0) [order[from], order[to]] = [speaker, order[from] ?? speaker];
    spot = speaker;
  }
  const unchanged = spot === previous.spot && order.length === previous.order.length && order.every((id, index) => id === previous.order[index]);
  return unchanged ? previous : { order, spot };
}
