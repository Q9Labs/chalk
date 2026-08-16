import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const componentRoot = new URL("../src/components/", import.meta.url);
const literalColor = /#[\da-f]{3,8}\b|\b(?:rgb|hsl)a?\(/iu;
const tokenOpacity = /(?:bg|text|border|ring|fill|stroke)-\[var\(--chalk-[a-z-]+\)\]\/\d+/giu;
const legacyColorVariable = /var\(--(?:accent|background|border|card|destructive|foreground|muted|popover|primary|ring|secondary|success|warning)(?:-[a-z-]+)?\)/giu;
const namedColorUtility =
  /(?:[a-z-]+:)*!?(?:bg|text|border|ring|fill|stroke)-(?:amber-\d+|background(?:-secondary|-tertiary)?|black|card(?:-foreground)?|chalk-(?:bg|border|error|text)-[a-z-]+|destructive(?:-foreground)?|foreground(?:-muted|-primary|-secondary)?|green-\d+|input|muted(?:-foreground)?|popover(?:-foreground)?|primary(?:-foreground)?|red-\d+|ring|secondary(?:-foreground)?|success|tile|warning|white|yellow-\d+|zinc-\d+)(?:\/\d+)?\b/giu;
const sources = await sourceFiles(componentRoot);
const violations = [];

for (const source of sources) {
  const text = withoutNarrowDataPalette(source.pathname, await readFile(source, "utf8"));
  const textWithoutClosedTokens = text.replace(/(?:bg|text|border|ring|fill|stroke)-\[var\(--chalk-[a-z-]+\)\]/giu, "");
  const failures = [...(text.match(literalColor) ?? []), ...(text.match(tokenOpacity) ?? []), ...(textWithoutClosedTokens.match(legacyColorVariable) ?? []), ...(textWithoutClosedTokens.match(namedColorUtility) ?? [])];
  if (failures.length > 0) violations.push(`${source.pathname}: ${[...new Set(failures)].join(", ")}`);
}

if (violations.length > 0) {
  throw new Error(`Component colors must use the closed Chalk theme tokens without palette utilities or opacity variants:\n${violations.join("\n")}`);
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(directory.pathname, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(new URL(`${entry.name}/`, directory))));
    if (entry.isFile() && /\.(?:[cm]?[jt]sx?|css)$/u.test(entry.name)) files.push(new URL(`file://${path}`));
  }

  return files;
}

function withoutNarrowDataPalette(sourcePath, text) {
  if (sourcePath.endsWith(".test.ts") || sourcePath.endsWith(".test.tsx")) return "";
  if (sourcePath.endsWith("/components/theme.ts")) return text.replace(/export const THEME_PALETTES = \[[\s\S]*?\] as const;/u, "export const THEME_PALETTES = [] as const;");
  if (!sourcePath.endsWith("/components/atomic/ReactionBubble.tsx")) return text;

  return text.replace(/const BASE_PARTICLE_COLORS = \[[^\]]+\];/u, "const BASE_PARTICLE_COLORS = [];");
}
