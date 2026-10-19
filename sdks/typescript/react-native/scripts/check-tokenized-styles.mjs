import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const sourceRoot = join(process.cwd(), "src");
const tokenSources = new Set(["theme/tokens.ts"]);
const sourceFilePattern = /\.(?:ts|tsx)$/u;
const styleLiteralPatterns = [
  /\b(?:backgroundColor|border\w*Color|color|fill|placeholderTextColor|shadowColor|stroke|stopColor)\s*:\s*["'](?:#[0-9a-f]{3,8}|rgba?\([^)]*\)|white|black|transparent)["']/giu,
  /\bboxShadow\s*:\s*["'][^"']*(?:#[0-9a-f]{3,8}|rgba?\()/giu,
  /\b(?:color|fill|placeholderTextColor|stroke)\s*=\s*["'](?:#[0-9a-f]{3,8}|rgba?\([^)]*\)|white|black|transparent)["']/giu,
];

const violations = [];
for (const filePath of await sourceFiles(sourceRoot)) {
  const relativePath = relative(sourceRoot, filePath);
  if (tokenSources.has(relativePath)) continue;

  const source = await readFile(filePath, "utf8");
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
