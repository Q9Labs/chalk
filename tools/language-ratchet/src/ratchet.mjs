import { createReadStream } from "node:fs";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";

export const TERMS = Object.freeze(["meeting", "conference", "videoconference", "room", "session", "attendee", "lobby", "waitingroom", "waiting_room", "waiting-room", "breakout", "huddle"]);

const SURFACES = Object.freeze(["apps/api", "apps/sync", "apps/web", "apps/mobile", "apps/docs", "sdks/typescript/client", "sdks/typescript/react", "sdks/typescript/react-native", "packages", "infrastructure", "tools", "docs", "root"]);

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

function countChunkTerm(text, counts, term, pattern, absoluteStart, minimumEnd, maximumEnd) {
  for (const match of text.matchAll(pattern)) {
    const absoluteEnd = absoluteStart + match.index + match[0].length;
    if (absoluteEnd > minimumEnd && absoluteEnd <= maximumEnd) counts[term] += 1;
  }
}

function countChunk(text, counts, absoluteStart, minimumEnd, maximumEnd) {
  for (const [term, pattern] of TERM_PATTERNS) countChunkTerm(text, counts, term, pattern, absoluteStart, minimumEnd, maximumEnd);
}

async function isRegularFile(filePath) {
  try {
    return (await lstat(filePath)).isFile();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function createCounterState() {
  return {
    counts: emptyTermCounts(),
    decoder: new StringDecoder("utf8"),
    carry: "",
    totalCharacters: 0,
    countedThrough: 0,
    binary: false,
  };
}

function consumeChunk(state, chunk) {
  if (state.binary) return;
  if (chunk.includes(0)) {
    state.binary = true;
    return;
  }

  const text = state.decoder.write(chunk);
  const combined = state.carry + text;
  const absoluteStart = state.totalCharacters - state.carry.length;
  const nextTotalCharacters = state.totalCharacters + text.length;
  const nextCountedThrough = Math.max(state.countedThrough, nextTotalCharacters - LOOKAHEAD_LENGTH);
  countChunk(combined, state.counts, absoluteStart, state.countedThrough, nextCountedThrough);
  state.countedThrough = nextCountedThrough;
  state.totalCharacters = nextTotalCharacters;
  state.carry = combined.slice(-CARRY_LENGTH);
}

function finishCounter(state) {
  if (state.binary) return null;

  const finalText = state.decoder.end();
  const combined = state.carry + finalText;
  const absoluteStart = state.totalCharacters - state.carry.length;
  const finalTotalCharacters = state.totalCharacters + finalText.length;
  countChunk(combined, state.counts, absoluteStart, state.countedThrough, finalTotalCharacters);
  return state.counts;
}

async function countTrackedFile(repositoryRoot, relativePath) {
  const filePath = path.join(repositoryRoot, relativePath);
  if (!(await isRegularFile(filePath))) return null;

  const state = createCounterState();
  const stream = createReadStream(filePath, { highWaterMark: 64 * 1024 });
  for await (const chunk of stream) consumeChunk(state, chunk);
  return finishCounter(state);
}

function isLockfile(relativePath) {
  const basename = path.posix.basename(relativePath).toLowerCase();
  return LOCKFILE_NAMES.has(basename) || basename.endsWith(".lock");
}

const REFERENCE_FILENAMES = new Set(["CHANGELOG.md", "GLOSSARY.md", "checklist.md"]);
const VENDORED_DIRECTORIES = new Set(["node_modules", "dist", "vendor", "sqlc"]);

function exclusionContext(relativePath) {
  const parts = relativePath.split("/");
  return { relativePath, parts, basename: parts.at(-1) ?? "", directories: parts.slice(0, -1) };
}

function isReferenceFile({ basename }) {
  return REFERENCE_FILENAMES.has(basename) || REFERENCE_FILENAMES.has(basename.toLowerCase());
}

function hasDirectory(directories, predicate) {
  return directories.some((directory) => predicate(directory.toLowerCase()));
}

function isVendoredDirectory(directory) {
  return VENDORED_DIRECTORIES.has(directory);
}

function isGeneratedDirectory(directory) {
  return GENERATED_DIRECTORY.test(directory);
}

function matchesGeneratedPath({ basename, directories }) {
  return hasDirectory(directories, isGeneratedDirectory) || GENERATED_FILE.test(basename);
}

const FROZEN_LEGACY_BROKER_PREFIX = `infrastructure/${"meet" + "ing"}-broker/`;

const EXCLUSION_RULES = [
  [({ relativePath }) => relativePath === "tools/language-ratchet/baseline.json", "ratchet baseline"],
  [({ parts }) => parts[0] === "scratchpad", "scratchpad"],
  // The old Worker is kept source-controlled only while its Durable Object drains.
  [({ relativePath }) => relativePath.startsWith(FROZEN_LEGACY_BROKER_PREFIX), "frozen legacy broker compatibility"],
  [({ relativePath }) => relativePath.startsWith("apps/api/db/migrations/"), "immutable migration history"],
  [isReferenceFile, "migration reference or checklist"],
  [({ relativePath }) => relativePath === "sdks/ubiquitous-language.md", "superseded vocabulary catalog"],
  [({ relativePath }) => isLockfile(relativePath), "lockfile or dependency checksum"],
  [({ directories }) => hasDirectory(directories, isVendoredDirectory), "generated or vendored directory"],
  [matchesGeneratedPath, "generated file or directory"],
];

export function exclusionReason(relativePath) {
  const context = exclusionContext(relativePath);
  return EXCLUSION_RULES.find(([matches]) => matches(context))?.[1] ?? null;
}

const FALLBACK_SURFACES = ["packages", "infrastructure", "tools", "docs"];

function surfacePrefix(relativePath, surface) {
  return relativePath.startsWith(`${surface}/`) ? surface : null;
}

function findSurface(relativePath, surfaces) {
  for (const surface of surfaces) {
    const match = surfacePrefix(relativePath, surface);
    if (match) return match;
  }
  return null;
}

export function surfaceFor(relativePath) {
  return findSurface(relativePath, SURFACE_PREFIXES) ?? findSurface(relativePath, FALLBACK_SURFACES) ?? "root";
}

function spawnGitFiles(repositoryRoot) {
  const git = spawn("git", ["ls-files", "-z"], { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  git.stderr.setEncoding("utf8");
  git.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const result = new Promise((resolve, reject) => {
    git.once("error", reject);
    git.once("close", (code, signal) => resolve({ code, signal }));
  });
  return { git, result, getStderr: () => stderr };
}

function splitGitPaths(pending, chunk) {
  const paths = `${pending}${chunk}`.split("\0");
  return { paths: paths.slice(0, -1), pending: paths.at(-1) ?? "" };
}

function ensureGitSuccess(exit, stderr) {
  if (exit.code !== 0) throw new Error(`git ls-files failed${stderr ? `: ${stderr.trim()}` : ""}`);
}

async function* trackedFiles(repositoryRoot) {
  const { git, result, getStderr } = spawnGitFiles(repositoryRoot);
  let pending = "";

  for await (const chunk of git.stdout) {
    const split = splitGitPaths(pending, chunk.toString("utf8"));
    pending = split.pending;
    yield* split.paths;
  }

  if (pending) yield pending;
  const exit = await result;
  ensureGitSuccess(exit, getStderr());
}

function addTermCounts(target, source, surface) {
  for (const term of TERMS) target[surface][term] += source[term];
}

async function addTrackedFileCounts(repositoryRoot, counts, relativePath) {
  if (exclusionReason(relativePath)) return;
  const fileCounts = await countTrackedFile(repositoryRoot, relativePath);
  if (!fileCounts) return;
  addTermCounts(counts, fileCounts, surfaceFor(relativePath));
}

async function countTrackedFiles(repositoryRoot) {
  const counts = emptyCounts();
  for await (const relativePath of trackedFiles(repositoryRoot)) await addTrackedFileCounts(repositoryRoot, counts, relativePath);
  return counts;
}

function validateTermCount(value, label, surface, term) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} has invalid count for ${surface}/${term}`);
}

function validateSurfaceCounts(surfaceCounts, label, surface) {
  if (!surfaceCounts || typeof surfaceCounts !== "object") throw new Error(`${label} is missing surface "${surface}"`);
  for (const term of TERMS) validateTermCount(surfaceCounts[term], label, surface, term);
}

function validateCounts(counts, label) {
  for (const surface of SURFACES) validateSurfaceCounts(counts?.[surface], label, surface);
}

function changeForCount(current, baseline, surface, term) {
  if (current === baseline) return null;
  const kind = current > baseline ? "increases" : "decreases";
  return {
    kind,
    value: { surface, term, baseline, current, delta: Math.abs(current - baseline) },
  };
}

function addChange(changes, current, baseline, surface, term) {
  const change = changeForCount(current, baseline, surface, term);
  if (change) changes[change.kind].push(change.value);
}

export function compareCounts(current, baseline) {
  validateCounts(current, "Current counts");
  validateCounts(baseline, "Baseline");
  const changes = { increases: [], decreases: [] };
  for (const surface of SURFACES) {
    for (const term of TERMS) addChange(changes, current[surface][term], baseline[surface][term], surface, term);
  }
  return changes;
}

async function updateBaseline(repositoryRoot, baselinePath, current) {
  await writeFile(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`Language ratchet baseline updated at ${path.relative(repositoryRoot, baselinePath)}.`);
  return 0;
}

async function readBaseline(repositoryRoot, baselinePath) {
  try {
    return JSON.parse(await readFile(baselinePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Baseline is missing at ${path.relative(repositoryRoot, baselinePath)}; run pnpm run language:ratchet:update.`);
    throw error;
  }
}

function reportIncreases(increases) {
  if (increases.length === 0) return;
  console.error("Language ratchet failed: banned-term counts increased.");
  for (const change of increases) {
    const scope = change.surface === "root" ? "." : change.surface;
    console.error(`- ${change.surface}/${change.term}: +${change.delta} (baseline ${change.baseline}, current ${change.current})`);
    console.error(`  Hint: git grep -n -I -i "${change.term}" -- ${scope}`);
  }
}

function reportDecreases(decreases) {
  if (decreases.length === 0) return;
  console.error("Language ratchet needs tightening: counts dropped below the committed baseline.");
  for (const change of decreases) console.error(`- ${change.surface}/${change.term}: decreased by ${change.delta} (baseline ${change.baseline}, current ${change.current})`);
  console.error("Run pnpm run language:ratchet:update to lock in these improvements.");
}

function reportComparison(comparison) {
  reportIncreases(comparison.increases);
  reportDecreases(comparison.decreases);
  return comparison.increases.length > 0 || comparison.decreases.length > 0;
}

export async function runRatchet({ repositoryRoot, baselinePath, update = false }) {
  const current = await countTrackedFiles(repositoryRoot);
  if (update) return updateBaseline(repositoryRoot, baselinePath, current);

  const baseline = await readBaseline(repositoryRoot, baselinePath);
  const comparison = compareCounts(current, baseline);
  if (!reportComparison(comparison)) {
    console.log("Language ratchet passed: all banned-term counts match the committed baseline.");
    return 0;
  }
  return 1;
}
