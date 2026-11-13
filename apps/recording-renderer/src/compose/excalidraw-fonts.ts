/**
 * Excalidraw font folder → the CSS family Excalidraw asks for. The Vite build
 * copies these folders and the whiteboard renderer registers them, so both read
 * this list. Xiaolai (CJK) is left out: it is large and Latin text never needs it.
 */
export const EXCALIDRAW_FONTS = [
  ["Excalifont", "Excalifont"],
  ["Virgil", "Virgil"],
  ["Cascadia", "Cascadia"],
  ["Nunito", "Nunito"],
  ["Lilita", "Lilita One"],
  ["ComicShanns", "Comic Shanns"],
  ["Liberation", "Liberation Sans"],
  ["Assistant", "Assistant"],
] as const;
