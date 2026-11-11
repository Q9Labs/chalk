/** A bottom sheet closes when dragged past this share of its height. */
export const SHEET_CLOSE_FRACTION = 0.3;
/** Or when it leaves the finger faster than this, in pixels per millisecond. */
export const SHEET_FLICK_SPEED = 0.5;
/** Upward drags move the sheet by this share of the finger travel, like a rubber band. */
export const SHEET_RUBBER_BAND = 0.3;
/** Spring back and slide away both take this long. */
export const SHEET_SETTLE_MS = 240;
/** Release speed is measured over the last stretch of the drag, not the whole of it. */
const SPEED_WINDOW_MS = 100;

export interface DragSample {
  readonly time: number;
  readonly y: number;
}

/** Where the sheet sits for a finger that has moved `travel` pixels down (negative is up). */
export function sheetOffset(travel: number): number {
  return travel < 0 ? travel * SHEET_RUBBER_BAND : travel;
}

/** Downward speed in pixels per millisecond over the last 100 ms of samples. */
export function releaseSpeed(samples: readonly DragSample[]): number {
  const last = samples.at(-1);
  const first = samples.find((sample) => last !== undefined && last.time - sample.time <= SPEED_WINDOW_MS);
  if (!last || !first || last.time === first.time) return 0;
  return (last.y - first.y) / (last.time - first.time);
}

export function shouldDismiss(offset: number, sheetHeight: number, speed: number): boolean {
  return offset > sheetHeight * SHEET_CLOSE_FRACTION || speed > SHEET_FLICK_SPEED;
}
