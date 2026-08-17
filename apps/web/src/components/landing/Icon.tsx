import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";

/**
 * Every icon on the marketing page sits next to the words it illustrates, so
 * none of them carry meaning of their own. Hugeicons does not hide its output
 * from assistive technology, which is the whole reason this wrapper exists:
 * without it a screen reader walks a page of unlabelled graphics.
 */
export function Icon({ glyph, size = 16, weight = 2 }: { glyph: IconSvgElement; size?: number; weight?: number }) {
  return <HugeiconsIcon icon={glyph} size={size} strokeWidth={weight} aria-hidden="true" focusable="false" />;
}
