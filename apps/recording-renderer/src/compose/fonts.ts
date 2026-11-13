import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { GlobalFonts } from "@napi-rs/canvas";

const EMOJI_FAMILIES = "Apple Color Emoji, Noto Color Emoji";

export interface FontRegistry {
  /**
   * Web fonts ship as unicode-range subsets that share one family name. Skia
   * picks a single face per family and never falls back between them, so each
   * subset is registered under its own name and the family expands to the list.
   * Returns the CSS family list for the family.
   */
  registerSubsetFamily(family: string, directory: string): Promise<string>;
  /** Rewrites a CSS font shorthand so every registered family names its subsets. */
  expandFontFamilies(font: string): string;
}

/**
 * The registry's families all fall back to one broad text font, for glyphs
 * their own subsets lack (e.g. arrows in Excalifont). Skia falls back through
 * the family list, not to system fonts.
 */
export async function createFontRegistry(textFallbackDirectory: string): Promise<FontRegistry> {
  const textFallback = `${(await registerFiles("TextFallback", textFallbackDirectory)).join(", ")}, `;
  const expansions: { readonly pattern: RegExp; readonly families: string }[] = [];
  return {
    async registerSubsetFamily(family, directory) {
      const names = await registerFiles(family, directory);
      const families = `${names.join(", ")}, ${textFallback}${EMOJI_FAMILIES}`;
      expansions.push({ pattern: new RegExp(`(^|[\\s,])["']?${escapeRegExp(family)}["']?(?=\\s*(,|$))`, "g"), families });
      return `${families}, sans-serif`;
    },
    expandFontFamilies(font) {
      let expanded = font;
      for (const { pattern, families } of expansions) expanded = expanded.replace(pattern, (_match, prefix: string) => `${prefix}${families}`);
      return expanded;
    },
  };
}

async function registerFiles(family: string, directory: string): Promise<string[]> {
  const files = (await readdir(directory)).filter((file) => /\.(woff2?|ttf|otf)$/.test(file)).sort();
  if (files.length === 0) throw new Error(`font family ${family} has no files in ${directory}`);
  return files.map((file, index) => {
    const name = `${family}__${index}`;
    if (GlobalFonts.registerFromPath(join(directory, file), name) === null) throw new Error(`font file ${file} could not be registered for ${family}`);
    return name;
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
