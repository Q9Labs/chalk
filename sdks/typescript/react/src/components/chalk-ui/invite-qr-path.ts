/** Modules and corner radius in module units. */
const MODULE_RADIUS = 0.5;
const FINDER_SIZE = 7;

export type QrMatrix = readonly (readonly boolean[])[];

/**
 * Rounded QR artwork as SVG path data. Every module keeps its full square, so the grid stays as solid and
 * high-contrast as a square code; a corner rounds only where both of its side neighbours are empty, which
 * joins touching modules into one shape. The three finder patterns are drawn as rounded rings with a rounded dot.
 */
export function roundedQrPaths(matrix: QrMatrix): { readonly modules: string; readonly finders: string } {
  const size = matrix.length;
  const on = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < size && y < size && matrix[y]?.[x] === true;
  const origins = [
    [0, 0],
    [size - FINDER_SIZE, 0],
    [0, size - FINDER_SIZE],
  ] as const;
  const inFinder = (x: number, y: number): boolean => origins.some(([fx, fy]) => x >= fx && x < fx + FINDER_SIZE && y >= fy && y < fy + FINDER_SIZE);
  const r = MODULE_RADIUS;

  const module = (x: number, y: number): string => {
    const up = on(x, y - 1);
    const down = on(x, y + 1);
    const left = on(x - 1, y);
    const right = on(x + 1, y);
    const tl = !up && !left ? r : 0;
    const tr = !up && !right ? r : 0;
    const br = !down && !right ? r : 0;
    const bl = !down && !left ? r : 0;
    return `M${x + tl} ${y}H${x + 1 - tr}${tr ? `a${tr} ${tr} 0 0 1 ${tr} ${tr}` : ""}V${y + 1 - br}${br ? `a${br} ${br} 0 0 1 -${br} ${br}` : ""}H${x + bl}${bl ? `a${bl} ${bl} 0 0 1 -${bl} -${bl}` : ""}V${y + tl}${tl ? `a${tl} ${tl} 0 0 1 ${tl} -${tl}` : ""}Z`;
  };

  let modules = "";
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (on(x, y) && !inFinder(x, y)) modules += module(x, y);

  const finders = origins
    .map(
      ([fx, fy]) =>
        `M${fx + 1.6} ${fy}h3.8a1.6 1.6 0 0 1 1.6 1.6v3.8a1.6 1.6 0 0 1-1.6 1.6h-3.8a1.6 1.6 0 0 1-1.6-1.6v-3.8a1.6 1.6 0 0 1 1.6-1.6zM${fx + 1.9} ${fy + 1}h3.2a.9 .9 0 0 1 .9 .9v3.2a.9 .9 0 0 1-.9 .9h-3.2a.9 .9 0 0 1-.9-.9v-3.2a.9 .9 0 0 1 .9-.9z` +
        `M${fx + 2.8} ${fy + 2}h1.4a.8 .8 0 0 1 .8 .8v1.4a.8 .8 0 0 1-.8 .8h-1.4a.8 .8 0 0 1-.8-.8v-1.4a.8 .8 0 0 1 .8-.8z`,
    )
    .join("");
  return { modules, finders };
}
