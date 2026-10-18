import type { Frame } from "../motion/MovingFrame";
import { STAGE_GAP } from "../frame/regions";

/**
 * A plain even grid, the mockup's `fill()`: the column count that gives the largest tiles within
 * the aspect bounds, rows centred in the stage. The stage lane replaces it with justified rows.
 */
export function evenGrid(stage: Frame, count: number, aspect: { readonly min: number; readonly max: number } = { min: 0.6, max: 2 }): readonly Frame[] {
  if (count === 0) return [];
  let best: { columns: number; rows: number; width: number; height: number } | null = null;
  for (let columns = 1; columns <= count; columns++) {
    const rows = Math.ceil(count / columns);
    let width = (stage.width - (columns - 1) * STAGE_GAP) / columns;
    let height = (stage.height - (rows - 1) * STAGE_GAP) / rows;
    if (width <= 0 || height <= 0) continue;
    if (width / height > aspect.max) width = height * aspect.max;
    else if (width / height < aspect.min) height = width / aspect.min;
    if (!best || width * height > best.width * best.height + 0.5) best = { columns, rows, width, height };
  }
  if (!best) return [];
  const { columns, rows, width, height } = best;
  const gridHeight = rows * height + (rows - 1) * STAGE_GAP;
  const top = stage.y + (stage.height - gridHeight) / 2;
  return Array.from({ length: count }, (_, index) => {
    const row = Math.floor(index / columns);
    const inRow = Math.min(columns, count - row * columns);
    const rowWidth = inRow * width + (inRow - 1) * STAGE_GAP;
    return { x: stage.x + (stage.width - rowWidth) / 2 + (index % columns) * (width + STAGE_GAP), y: top + row * (height + STAGE_GAP), width, height };
  });
}
