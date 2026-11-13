/** The wait after the `failures`-th failure in a row (1 for the first): `baseMs`, doubling each time, never above `capMs`. */
export function backoffMs(failures: number, baseMs: number, capMs: number): number {
  return Math.min(baseMs * 2 ** (failures - 1), capMs);
}
