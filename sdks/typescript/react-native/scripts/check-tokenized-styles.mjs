import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { colorSource, colorProperty, namedColorPattern } from "../../../../scripts/gates/color-source.mjs";

const sourceRoot = join(process.cwd(), "src");
const tokenSources = new Set(["theme/tokens.ts"]);
const sourceFilePattern = /\.(?:ts|tsx)$/u;
const styleLiteralPatterns = [
  namedColorPattern,
  new RegExp(`["']?${colorProperty}["']?\\s*(?::|=)\\s*\\{?\\s*["'](?:#[0-9a-f]{3,8}|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\\([^)]*\\))["']`, "giu"),
  /\bboxShadow\s*:\s*["'][^"']*(?:#[0-9a-f]{3,8}|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\()/giu,
];

const violations = [];
for (const filePath of await sourceFiles(sourceRoot)) {
  const relativePath = relative(sourceRoot, filePath);
  if (tokenSources.has(relativePath) || /\.(?:test|spec)\.tsx?$/u.test(relativePath)) continue;

  const source = colorSource(await readFile(filePath, "utf8"), filePath);
  for (const pattern of styleLiteralPatterns) {
    for (const match of source.matchAll(pattern)) {
      const line = source.slice(0, match.index).split("\n").length;
      violations.push(`${relativePath}:${line}: ${match[0]}`);
    }
  }
}

if (violations.length > 0) {
  console.error("Raw colours in React Native styles are forbidden. Add or reuse a token in src/theme/tokens.ts instead:\n");
  console.error(violations.join("\n"));
  process.exitCode = 1;
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const filePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(filePath)));
    } else if (entry.isFile() && sourceFilePattern.test(entry.name)) {
      files.push(filePath);
    }
  }
  return files;
}
