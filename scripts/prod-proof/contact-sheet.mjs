import { check } from "./runtime.mjs";

export function contactSheetFont(fonts, platform = process.platform) {
  // macOS ImageMagick can have no registered fonts despite system fonts existing.
  if (platform === "darwin" && !fonts.trim()) return "/System/Library/Fonts/Supplemental/Arial.ttf";
  const font = fonts.match(/^\s*Font:\s*(\S.*)$/m)?.[1].trim();
  check(font, "ImageMagick has no installed font for the contact sheet");
  return font;
}
