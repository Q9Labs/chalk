/**
 * The Chalk mark, direction B2: one chalk stick leaning toward the word, with its dust falling away
 * behind it. This is the only place it is drawn. `ChalkMark.tsx` renders it in the app and
 * `scripts/brand-assets.ts` renders the app icon and splash from it, so a logo swap is one change here.
 */
export const MARK = {
  viewBox: 48,
  rotation: 28,
  stick: "M18 8h12v28a6 6 0 0 1-12 0z",
  cap: "M18 8h12l-1.5 4.5h-9z",
  capOpacity: 0.45,
  /** Chalk dust as x, y, radius and opacity. */
  dust: [
    [10.5, 41.5, 1.7, 0.55],
    [6.5, 37, 1.2, 0.4],
    [4, 43.5, 0.85, 0.28],
  ],
} as const;

/** The app icon's plate and the mark's colour on it. */
export const ICON_COLORS = { plate: "#16181c", mark: "#f1f0ea" } as const;

/** The mark as SVG markup in a 48-unit box, in one colour. */
export function markSvgBody(color: string): string {
  const dust = MARK.dust.map(([x, y, r, o]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${color}" opacity="${o}"/>`).join("");
  return `<g transform="rotate(${MARK.rotation} 24 24)"><path d="${MARK.stick}" fill="${color}"/><path d="${MARK.cap}" fill="${color}" opacity="${MARK.capOpacity}"/></g>${dust}`;
}
