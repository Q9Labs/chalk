import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const componentRoot = resolve(scriptDir, "../src/components");
const baselinePath = join(scriptDir, "token-reach-baseline.json");
const patterns = [
  ["literal", /#[\da-f]{3,8}\b|\b(?:rgb|hsl)a?\(/giu],
  ["token-opacity", /(?:bg|text|border|ring|fill|stroke)-\[var\(--chalk-[a-z-]+\)\]\/\d+/giu],
  ["legacy-variable", /var\(--(?:accent|background|border|card|destructive|foreground|muted|popover|primary|ring|secondary|success|warning)(?:-[a-z-]+)?\)/giu],
  [
    "palette-utility",
    /(?<![a-z\d_-])(?:[a-z-]+:)*!?(?:bg|text|border|ring|fill|stroke)-(?:[a-z]+-\d+|background(?:-secondary|-tertiary)?|black|card(?:-foreground)?|chalk-(?:bg|border|error|text)-[a-z-]+|destructive(?:-foreground)?|foreground(?:-muted|-primary|-secondary)?|input|muted(?:-foreground)?|popover(?:-foreground)?|primary(?:-foreground)?|ring|secondary(?:-foreground)?|success|tile|warning|white)(?:\/\d+)?\b/giu,
  ],
];

export async function findTokenViolations(root = componentRoot) {
  const violations = [];
  for (const file of await sourceFiles(root)) {
    const sourcePath = relative(root, file).replaceAll("\\", "/");
    const text = withoutNarrowDataPalette(sourcePath, await readFile(file, "utf8"));
    const withoutClosedTokens = text.replace(/(?:bg|text|border|ring|fill|stroke)-\[var\(--chalk-[a-z-]+\)\]/giu, "");
    for (const [rule, pattern] of patterns) {
      const input = rule === "legacy-variable" || rule === "palette-utility" ? withoutClosedTokens : text;
      for (const match of input.matchAll(pattern)) {
        const start = input.lastIndexOf("\n", match.index) + 1;
        const end = input.indexOf("\n", match.index);
        const lineText = input.slice(start, end === -1 ? undefined : end).trim();
        const fingerprint = createHash("sha256").update(`${sourcePath}\0${rule}\0${match[0]}\0${lineText}`).digest("hex");
        violations.push({ file: sourcePath, line: input.slice(0, match.index).split("\n").length, rule, value: match[0], fingerprint });
      }
    }
  }
  return violations;
}

export function compareBaseline(violations, baseline) {
  const remaining = Object.fromEntries(baseline.map(({ fingerprint, count }) => [fingerprint, count]));
  const added = [];
  for (const violation of violations) {
    if (remaining[violation.fingerprint] > 0) remaining[violation.fingerprint]--;
    else added.push(violation);
  }
  return { added, removed: Object.values(remaining).reduce((sum, count) => sum + count, 0) };
}

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (entry.isFile() && /\.(?:[cm]?[jt]sx?|css)$/u.test(entry.name)) files.push(path);
  }
  return files;
}

function withoutNarrowDataPalette(sourcePath, text) {
  if (/\.test\.tsx?$/u.test(sourcePath)) return "";
  if (sourcePath === "theme.ts") return text.replace(/export const THEME_PALETTES = \[[\s\S]*?\] as const;/u, "export const THEME_PALETTES = [] as const;");
  if (sourcePath === "atomic/ReactionBubble.tsx") return text.replace(/const BASE_PARTICLE_COLORS = \[[^\]]+\];/u, "const BASE_PARTICLE_COLORS = [];");
  return text;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = await findTokenViolations();
  if (process.argv.includes("--update-baseline")) {
    const entries = new Map();
    for (const { file, rule, value, fingerprint } of violations) {
      const existing = entries.get(fingerprint);
      if (existing) existing.count++;
      else entries.set(fingerprint, { file, rule, value, fingerprint, count: 1 });
    }
    await writeFile(
      baselinePath,
      `${JSON.stringify(
        [...entries.values()].sort((a, b) => a.file.localeCompare(b.file) || a.fingerprint.localeCompare(b.fingerprint)),
        null,
        2,
      )}\n`,
    );
    console.log(`Recorded ${violations.length} existing token violations; remove these as components are updated.`);
  } else {
    const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
    const { added, removed } = compareBaseline(violations, baseline);
    if (added.length) {
      console.error("New component colors must use Chalk theme tokens:\n" + added.map(({ file, line, value, rule }) => `${file}:${line}: ${rule}: ${value}`).join("\n"));
      process.exitCode = 1;
    }
    if (removed) {
      console.error(`${removed} baseline token violation(s) were removed or changed. Run pnpm --filter @q9labsai/chalk-react run check:tokens -- --update-baseline and review the baseline diff.`);
      process.exitCode = 1;
    }
    if (!added.length && !removed) console.log(`No new token violations (${violations.length} existing violations remain in the baseline).`);
  }
}
