import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { GlobalFonts } from "@napi-rs/canvas";

const EMOJI_FAMILIES = "Apple Color Emoji, Noto Color Emoji";
const expansions: { readonly pattern: RegExp; readonly families: string }[] = [];

/**
 * Web fonts ship as unicode-range subsets that share one family name. Skia
 * picks a single face per family and never falls back between them, so each
 * subset is registered under its own name and the family expands to the list.
 */
export async function registerSubsetFamily(family: string, directory: string): Promise<string> {
  const files = (await readdir(directory)).filter((file) => /\.(woff2?|ttf|otf)$/.test(file)).sort();
  if (files.length === 0) throw new Error(`font family ${family} has no files in ${directory}`);
  const names: string[] = [];
  for (const [index, file] of files.entries()) {
    const name = `${family}__${index}`;
    if (GlobalFonts.registerFromPath(join(directory, file), name) === null) throw new Error(`font file ${file} could not be registered for ${family}`);
    names.push(name);
  }
  const families = `${names.join(", ")}, ${EMOJI_FAMILIES}`;
  expansions.push({ pattern: new RegExp(`(^|[\\s,])["']?${escapeRegExp(family)}["']?(?=\\s*(,|$))`, "g"), families });
  return `${families}, sans-serif`;
}

/** Rewrites a CSS font shorthand so every registered family names its subsets. */
export function expandFontFamilies(font: string): string {
  let expanded = font;
  for (const { pattern, families } of expansions) expanded = expanded.replace(pattern, (_match, prefix: string) => `${prefix}${families}`);
  return expanded;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
