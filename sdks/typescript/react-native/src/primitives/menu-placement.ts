export type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
export type Insets = { readonly top: number; readonly bottom: number; readonly left: number; readonly right: number };

export type MenuPlacement = {
  readonly x: number;
  readonly y: number;
  /** Set when the menu is taller than the room inside the safe area; the menu then scrolls. */
  readonly maxHeight: number | null;
  readonly side: "below" | "above";
};

/** Gap between the trigger and the menu. */
const GAP = 6;
/** Distance kept from the safe area's edges. */
const MARGIN = 8;

/**
 * Places a menu next to its trigger, as the mockup's `fitBox` does: below the trigger unless
 * there's more room above, shifted sideways to stay on screen, and always inside the safe area
 * (clear of the status bar, the Dynamic Island, the home indicator and the keyboard).
 */
export function placeMenu(trigger: Rect, menu: { readonly width: number; readonly height: number }, screen: { readonly width: number; readonly height: number }, insets: Insets, keyboardHeight = 0): MenuPlacement {
  const top = insets.top + MARGIN;
  const bottom = screen.height - Math.max(insets.bottom, keyboardHeight) - MARGIN;
  const left = insets.left + MARGIN;
  const right = screen.width - insets.right - MARGIN;
  const maxHeight = menu.height > bottom - top ? bottom - top : null;
  const height = maxHeight ?? menu.height;
  const roomBelow = bottom - (trigger.y + trigger.height + GAP);
  const roomAbove = trigger.y - GAP - top;
  const below = height <= roomBelow || roomBelow >= roomAbove;
  const y = below ? trigger.y + trigger.height + GAP : trigger.y - GAP - height;
  return {
    x: clamp(trigger.x + trigger.width / 2 - menu.width / 2, left, right - menu.width),
    y: clamp(y, top, bottom - height),
    maxHeight,
    side: below ? "below" : "above",
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
