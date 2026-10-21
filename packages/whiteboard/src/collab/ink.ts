/** Ink travels and records as Paper's ink; each viewer paints it in their own surface's ink. */
export const CANONICAL_INK = "#1b1c1f";

export function withInk<T extends { readonly strokeColor: string }>(element: T, from: string, to: string): T {
  return from !== to && element.strokeColor.toLowerCase() === from.toLowerCase() ? { ...element, strokeColor: to } : element;
}
