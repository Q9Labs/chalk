/**
 * Renders the web favicon, app icons and social share images from the Chalk mark in
 * `src/lib/chalk-mark.ts`, for production and for nightly:
 * `pnpm --filter @q9labsai/chalk-web exec tsx scripts/brand-assets.ts`
 * (needs `rsvg-convert` and `magick`, from `brew install librsvg imagemagick`).
 * Nightly keeps the mark and swaps the plate for a night sky, the way T3 Code tells its builds apart.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MARK, markSvgBody } from "../src/lib/chalk-mark.ts";

const SIZE = 1024;
const ICON_COLORS = { plate: "#16181c", mark: "#f1f0ea" } as const;
const OG_VERSION = "20261024";
const here = import.meta.dirname;
const publicDir = join(here, "../public");
// Figtree ships with the mobile app; rsvg-convert needs the files to set the share image text.
const fontsDir = join(here, "../../mobile/assets/fonts");
const work = mkdtempSync(join(tmpdir(), "chalk-web-brand-"));

const OG_BACKGROUND = "#0b0c0e";
const OG_TEXT = "#ececee";
const OG_MUTED = "#9ea0a8";

type Channel = "production" | "nightly";

/** Hand-placed so every render is identical: x, y, radius and opacity in a 1024 square. */
const STARS = [
  [120, 150, 5, 0.9],
  [300, 90, 3.5, 0.6],
  [450, 130, 3, 0.45],
  [700, 60, 3, 0.5],
  [860, 130, 6, 0.85],
  [930, 300, 3, 0.5],
  [70, 420, 3.5, 0.55],
  [60, 640, 4.5, 0.7],
  [960, 520, 4, 0.6],
  [780, 720, 3, 0.45],
  [150, 760, 3, 0.5],
  [300, 900, 4, 0.6],
  [520, 950, 3.5, 0.5],
  [880, 860, 5, 0.7],
] as const;

/** Stars spread over a `width` by `height` box, round at any aspect, and only right of `fromX` so text stays clear. */
function stars(width: number, height: number, fromX: number): string {
  return STARS.map(([x, y, r, opacity]) => ({ cx: (x / SIZE) * width, cy: (y / SIZE) * height, r, opacity }))
    .filter(({ cx }) => cx >= fromX)
    .map(({ cx, cy, r, opacity }) => `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r}" fill="${ICON_COLORS.mark}" opacity="${opacity}"/>`)
    .join("");
}

/** What sits behind the mark, drawn in a `width` by `height` box. */
function backdrop(channel: Channel, width: number, height: number, starsFromX = 0): string {
  if (channel === "production") return `<rect width="${width}" height="${height}" fill="${ICON_COLORS.plate}"/>`;
  return [
    `<defs><linearGradient id="sky" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0" stop-color="#0d1330"/><stop offset="1" stop-color="#2d2262"/></linearGradient>`,
    `<radialGradient id="glow" cx="0.2" cy="1" r="0.8"><stop offset="0" stop-color="#6d4fc2" stop-opacity="0.55"/><stop offset="1" stop-color="#6d4fc2" stop-opacity="0"/></radialGradient></defs>`,
    `<rect width="${width}" height="${height}" fill="url(#sky)"/><rect width="${width}" height="${height}" fill="url(#glow)"/>`,
    stars(width, height, starsFromX),
  ].join("");
}

/** The mark centred in a box of `box` units, drawn in a `SIZE` square. */
function centredMark(box: number, color: string): string {
  const side = SIZE * box;
  const offset = (SIZE - side) / 2;
  return `<svg x="${offset}" y="${offset}" width="${side}" height="${side}" viewBox="0 0 ${MARK.viewBox} ${MARK.viewBox}">${markSvgBody(color)}</svg>`;
}

/** An icon with its plate: rounded for tabs and "any" icons, full-bleed where the OS applies its own mask. */
function iconSvg(channel: Channel, box: number, rounded: boolean): string {
  const clip = rounded ? `<clipPath id="round"><rect width="${SIZE}" height="${SIZE}" rx="232"/></clipPath>` : "";
  const plate = rounded ? `<g clip-path="url(#round)">${backdrop(channel, SIZE, SIZE)}</g>` : backdrop(channel, SIZE, SIZE);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">${clip}${plate}${centredMark(box, ICON_COLORS.mark)}</svg>`;
}

/** The "New Space" shortcut: a plus on the channel's plate. */
function shortcutSvg(channel: Channel): string {
  const plus = `<path d="M512 292V732M292 512H732" stroke="${ICON_COLORS.mark}" stroke-width="96" stroke-linecap="round"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}"><clipPath id="round"><rect width="${SIZE}" height="${SIZE}" rx="232"/></clipPath><g clip-path="url(#round)">${backdrop(channel, SIZE, SIZE)}</g>${plus}</svg>`;
}

function ogSvg(channel: Channel): string {
  const width = 1200;
  const height = 630;
  const background = channel === "production" ? `<rect width="${width}" height="${height}" fill="${OG_BACKGROUND}"/>` : backdrop(channel, width, height, 640);
  const badge =
    channel === "nightly" ? `<rect x="294" y="86" width="128" height="40" rx="20" fill="none" stroke="${OG_TEXT}" stroke-opacity="0.4"/><text x="358" y="113" text-anchor="middle" font-family="Figtree" font-weight="600" font-size="20" letter-spacing="3" fill="${OG_TEXT}">NIGHTLY</text>` : "";
  const mark = (x: number, y: number, side: number, opacity: number) => `<svg x="${x}" y="${y}" width="${side}" height="${side}" viewBox="0 0 ${MARK.viewBox} ${MARK.viewBox}" opacity="${opacity}">${markSvgBody(ICON_COLORS.mark)}</svg>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
${background}
${mark(780, 30, 600, 0.07)}
${mark(76, 70, 64, 1)}
<text x="148" y="122" font-family="Figtree" font-weight="700" font-size="48" fill="${OG_TEXT}">chalk</text>
${badge}
<text x="80" y="370" font-family="Figtree" font-weight="700" font-size="72" letter-spacing="-1.5" fill="${OG_TEXT}">Calls for your team,</text>
<text x="80" y="454" font-family="Figtree" font-weight="700" font-size="72" letter-spacing="-1.5" fill="${OG_TEXT}">and inside your product.</text>
<text x="80" y="540" font-family="Figtree" font-weight="400" font-size="30" fill="${OG_MUTED}">Open source for web, iOS and Android.</text>
</svg>`;
}

function render(name: string, svg: string, outFile: string, width: number, height = width): void {
  const source = join(work, `${name}.svg`);
  writeFileSync(source, svg);
  const fontConfig = join(work, "fonts.conf");
  writeFileSync(fontConfig, `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>${fontsDir}</dir><cachedir>${join(work, "fontcache")}</cachedir></fontconfig>`);
  execFileSync("rsvg-convert", ["--width", String(width), "--height", String(height), "--output", outFile, source], { env: { ...process.env, FONTCONFIG_FILE: fontConfig, PANGOCAIRO_BACKEND: "fc" } });
}

function writeIconSet(channel: Channel): void {
  const directory = channel === "production" ? join(publicDir, "brand/chalk") : join(publicDir, "brand/chalk/nightly");
  mkdirSync(directory, { recursive: true });

  // The mark takes 44 of the 60 units of a mobile icon; Android-style maskable icons keep it inside the middle 60%.
  const anyBox = 44 / 60;
  const maskableBox = 0.6;
  writeFileSync(join(directory, "chalk-icon.svg"), iconSvg(channel, anyBox, true));
  writeFileSync(join(directory, "chalk-icon-maskable.svg"), iconSvg(channel, maskableBox, false));
  writeFileSync(join(directory, "shortcut-new.svg"), shortcutSvg(channel));
  for (const side of [192, 512]) {
    render(`${channel}-any-${side}`, iconSvg(channel, anyBox, true), join(directory, `chalk-icon-${side}.png`), side);
    render(`${channel}-maskable-${side}`, iconSvg(channel, maskableBox, false), join(directory, `chalk-icon-maskable-${side}.png`), side);
  }
  render(`${channel}-shortcut`, shortcutSvg(channel), join(directory, "shortcut-new-192.png"), 192);
  render(`${channel}-apple`, iconSvg(channel, anyBox, false), join(directory, "apple-touch-icon.png"), 180);

  // Small tabs read better with a bigger mark; the dust specks do not survive below 32px.
  const tabSizes = [16, 32, 48];
  const tabFiles = tabSizes.map((side) => {
    const file = join(work, `${channel}-tab-${side}.png`);
    render(`${channel}-tab-${side}`, iconSvg(channel, 0.82, true), file, side);
    return file;
  });
  const icoPath = channel === "production" ? join(publicDir, "favicon.ico") : join(directory, "favicon.ico");
  execFileSync("magick", [...tabFiles, icoPath]);

  const ogName = channel === "production" ? `chalk-og-${OG_VERSION}.png` : `chalk-og-nightly-${OG_VERSION}.png`;
  render(`${channel}-og`, ogSvg(channel), join(publicDir, "images/social", ogName), 1200, 630);
}

writeIconSet("production");
writeIconSet("nightly");
