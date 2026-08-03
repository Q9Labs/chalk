import { createReadStream } from "node:fs";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";

export const TERMS = Object.freeze(["meeting", "conference", "videoconference", "room", "session", "attendee", "waitingroom", "waiting_room", "waiting-room"]);

export const SURFACES = Object.freeze(["apps/api", "apps/sync", "apps/web", "apps/mobile", "apps/docs", "sdks/typescript/client", "sdks/typescript/react", "sdks/typescript/react-native", "packages", "infrastructure", "tools", "docs", "root"]);

const GENERATED_DIRECTORY = /generated/i;
const GENERATED_FILE = /^(?:generated|.*_generated)/i;
const MAX_TERM_LENGTH = Math.max(...TERMS.map((term) => term.length));
const LOOKAHEAD_LENGTH = MAX_TERM_LENGTH + 2;
const CARRY_LENGTH = LOOKAHEAD_LENGTH + MAX_TERM_LENGTH;
const LOCKFILE_NAMES = new Set([
  ".terraform.lock.hcl",
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "composer.lock",
  "deno.lock",
  "gemfile.lock",
  "go.sum",
  "mix.lock",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "pipfile.lock",
  "podfile.lock",
  "pnpm-lock.yaml",
  "pnpm-lock.yml",
  "poetry.lock",
  "skills-lock.json",
  "uv.lock",
  "yarn.lock",
]);

const SURFACE_PREFIXES = SURFACES.filter((surface) => surface !== "packages" && surface !== "infrastructure" && surface !== "tools" && surface !== "root");

function emptyTermCounts() {
  return Object.fromEntries(TERMS.map((term) => [term, 0]));
}

export function emptyCounts() {
  return Object.fromEntries(SURFACES.map((surface) => [surface, emptyTermCounts()]));
}

function escapeRegexCharacter(character) {
  return /[A-Za-z]/.test(character) ? `[${character.toLowerCase()}${character.toUpperCase()}]` : character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function termPattern(term) {
  const literal = [...term].map(escapeRegexCharacter).join("");
  const start = String.raw`(?:(?<![A-Za-z0-9])|(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z]))`;
  const end = String.raw`(?=$|[^A-Za-z0-9]|(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z]))`;
  return new RegExp(`${start}${literal}${end}`, "g");
}

const TERM_PATTERNS = new Map(TERMS.map((term) => [term, termPattern(term)]));

export function countText(text) {
  const counts = emptyTermCounts();
  for (const [term, pattern] of TERM_PATTERNS) {
    for (const _match of text.matchAll(pattern)) counts[term] += 1;
  }
  return counts;
}

function countChunk(text, counts, absoluteStart, minimumEnd, maximumEnd) {
  for (const [term, pattern] of TERM_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const absoluteEnd = absoluteStart + match.index + match[0].length;
      if (absoluteEnd > minimumEnd && absoluteEnd <= maximumEnd) counts[term] += 1;
    }
  }
}

async function isRegularFile(filePath) {
  try {
    return (await lstat(filePath)).isFile();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

// Streaming overlap state stays cohesive so term matches crossing chunk boundaries are counted once.
// fallow-ignore-next-line complexity
async function countTrackedFile(repositoryRoot, relativePath) {
  const filePath = path.join(repositoryRoot, relativePath);
  if (!(await isRegularFile(filePath))) return null;

  const counts = emptyTermCounts();
  const decoder = new StringDecoder("utf8");
  const stream = createReadStream(filePath, { highWaterMark: 64 * 1024 });
  let carry = "";
  let totalCharacters = 0;
  let countedThrough = 0;
  let binary = false;

  for await (const chunk of stream) {
    if (chunk.includes(0)) {
      binary = true;
      continue;
    }
    if (binary) continue;

    const text = decoder.write(chunk);
    const combined = carry + text;
    const absoluteStart = totalCharacters - carry.length;
    const nextTotalCharacters = totalCharacters + text.length;
    const nextCountedThrough = Math.max(countedThrough, nextTotalCharacters - LOOKAHEAD_LENGTH);
    countChunk(combined, counts, absoluteStart, countedThrough, nextCountedThrough);
    countedThrough = nextCountedThrough;
    totalCharacters = nextTotalCharacters;
    carry = combined.slice(-CARRY_LENGTH);
  }

  if (binary) return null;

  const finalText = decoder.end();
  const combined = carry + finalText;
  const absoluteStart = totalCharacters - carry.length;
  const finalTotalCharacters = totalCharacters + finalText.length;
  countChunk(combined, counts, absoluteStart, countedThrough, finalTotalCharacters);
  return counts;
}

function isLockfile(relativePath) {
  const basename = path.posix.basename(relativePath).toLowerCase();
  return LOCKFILE_NAMES.has(basename) || basename.endsWith(".lock");
}

export function exclusionReason(relativePath) {
  const parts = relativePath.split("/");
  const basename = parts.at(-1) ?? "";
  const directories = parts.slice(0, -1);

  if (relativePath === "tools/language-ratchet/baseline.json") return "ratchet baseline";
  if (parts[0] === "scratchpad") return "scratchpad";
  if (basename === "CHANGELOG.md" || basename === "GLOSSARY.md" || basename.toLowerCase() === "checklist.md") return "migration reference or checklist";
  if (relativePath === "sdks/ubiquitous-language.md") return "superseded vocabulary catalog";
  if (isLockfile(relativePath)) return "lockfile or dependency checksum";
  if (directories.some((directory) => ["node_modules", "dist", "vendor", "sqlc"].includes(directory.toLowerCase()))) return "generated or vendored directory";
  if (directories.some((directory) => GENERATED_DIRECTORY.test(directory)) || GENERATED_FILE.test(basename)) return "generated file or directory";
  return null;
}

export function surfaceFor(relativePath) {
  const exactSurface = SURFACE_PREFIXES.find((surface) => relativePath.startsWith(`${surface}/`));
  if (exactSurface) return exactSurface;
  if (relativePath.startsWith("packages/")) return "packages";
  if (relativePath.startsWith("infrastructure/")) return "infrastructure";
  if (relativePath.startsWith("tools/")) return "tools";
  if (relativePath.startsWith("docs/")) return "docs";
  return "root";
}

async function* trackedFiles(repositoryRoot) {
  const git = spawn("git", ["ls-files", "-z"], { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] });
  let pending = "";
  let stderr = "";
  git.stderr.setEncoding("utf8");
  git.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const result = new Promise((resolve, reject) => {
    git.once("error", reject);
    git.once("close", (code, signal) => resolve({ code, signal }));
  });

  for await (const chunk of git.stdout) {
    pending += chunk.toString("utf8");
    const paths = pending.split("\0");
    pending = paths.pop() ?? "";
    for (const relativePath of paths) yield relativePath;
  }

  if (pending) yield pending;
  const exit = await result;
  if (exit.code !== 0) throw new Error(`git ls-files failed${stderr ? `: ${stderr.trim()}` : ""}`);
}

export async function countTrackedFiles(repositoryRoot) {
  const counts = emptyCounts();
  for await (const relativePath of trackedFiles(repositoryRoot)) {
    if (exclusionReason(relativePath)) continue;
    const fileCounts = await countTrackedFile(repositoryRoot, relativePath);
    if (!fileCounts) continue;
    const surface = surfaceFor(relativePath);
    for (const term of TERMS) counts[surface][term] += fileCounts[term];
  }
  return counts;
}

function validateCounts(counts, label) {
  for (const surface of SURFACES) {
    if (!counts || typeof counts[surface] !== "object") throw new Error(`${label} is missing surface "${surface}"`);
    for (const term of TERMS) {
      const value = counts[surface][term];
      if (!Number.isInteger(value) || value < 0) throw new Error(`${label} has invalid count for ${surface}/${term}`);
    }
  }
}

export function compareCounts(current, baseline) {
  validateCounts(current, "Current counts");
  validateCounts(baseline, "Baseline");
  const increases = [];
  const decreases = [];
  for (const surface of SURFACES) {
    for (const term of TERMS) {
      const currentCount = current[surface][term];
      const baselineCount = baseline[surface][term];
      if (currentCount > baselineCount) increases.push({ surface, term, baseline: baselineCount, current: currentCount, delta: currentCount - baselineCount });
      if (currentCount < baselineCount) decreases.push({ surface, term, baseline: baselineCount, current: currentCount, delta: baselineCount - currentCount });
    }
  }
  return { increases, decreases };
}

export async function runRatchet({ repositoryRoot, baselinePath, update = false }) {
  const current = await countTrackedFiles(repositoryRoot);
  if (update) {
    await writeFile(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
    console.log(`Language ratchet baseline updated at ${path.relative(repositoryRoot, baselinePath)}.`);
    return 0;
  }

  let baseline;
  try {
    baseline = JSON.parse(await readFile(baselinePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Baseline is missing at ${path.relative(repositoryRoot, baselinePath)}; run pnpm run language:ratchet:update.`);
    throw error;
  }

  const comparison = compareCounts(current, baseline);
  if (comparison.increases.length === 0 && comparison.decreases.length === 0) {
    console.log("Language ratchet passed: all banned-term counts match the committed baseline.");
    return 0;
  }

  if (comparison.increases.length > 0) {
    console.error("Language ratchet failed: banned-term counts increased.");
    for (const change of comparison.increases) {
      const scope = change.surface === "root" ? "." : change.surface;
      console.error(`- ${change.surface}/${change.term}: +${change.delta} (baseline ${change.baseline}, current ${change.current})`);
      console.error(`  Hint: git grep -n -I -i "${change.term}" -- ${scope}`);
    }
  }
  if (comparison.decreases.length > 0) {
    console.error("Language ratchet needs tightening: counts dropped below the committed baseline.");
    for (const change of comparison.decreases) console.error(`- ${change.surface}/${change.term}: decreased by ${change.delta} (baseline ${change.baseline}, current ${change.current})`);
    console.error("Run pnpm run language:ratchet:update to lock in these improvements.");
  }
  return 1;
}
