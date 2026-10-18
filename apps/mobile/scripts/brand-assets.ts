/**
 * Renders the app icon and splash images from the mark in `src/brand/mark.ts`:
 * `pnpm --filter @q9labsai/chalk-mobile run brand-assets` (needs `rsvg-convert`, from `brew install librsvg`).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ICON_COLORS, MARK, markSvgBody } from "../src/brand/mark";

const SIZE = 1024;
const assets = join(__dirname, "../assets");
const SPLASH_MARK = "#ECECEE";

type Plate = { readonly fill: string } | null;

/** A square image with the mark centred in a box of `box` pixels, on an optional plate. */
function markImage(box: number, color: string, plate: Plate): string {
  const offset = (SIZE - box) / 2;
  const background = plate ? `<rect width="${SIZE}" height="${SIZE}" fill="${plate.fill}"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">${background}<svg x="${offset}" y="${offset}" width="${box}" height="${box}" viewBox="0 0 ${MARK.viewBox} ${MARK.viewBox}">${markSvgBody(color)}</svg></svg>`;
}

const work = mkdtempSync(join(tmpdir(), "chalk-brand-"));
function render(name: string, svg: string, size = SIZE): void {
  const source = join(work, `${name}.svg`);
  writeFileSync(source, svg);
  execFileSync("rsvg-convert", ["--width", String(size), "--height", String(size), "--output", join(assets, `${name}.png`), source]);
}

// The icon is full-bleed because the OS rounds it. The mark takes 44 of the mockup icon's 60 units.
render("icon", markImage((SIZE * 44) / 60, ICON_COLORS.mark, { fill: ICON_COLORS.plate }));
// Android masks the foreground to its middle two thirds, so the mark stays well inside it.
render("adaptive-icon", markImage(SIZE * 0.6, ICON_COLORS.mark, null));
render("adaptive-icon-monochrome", markImage(SIZE * 0.6, "#000000", null));
// The splash shows the mark alone on the call background, 112 pt wide at 3x.
render("splash-mark", markImage(SIZE, SPLASH_MARK, null), 336);
