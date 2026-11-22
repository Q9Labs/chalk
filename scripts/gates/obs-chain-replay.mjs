#!/usr/bin/env node
// Replays each symptom's chain in write mode and fails on any difference, so a committed hand-off file or fixture is exactly what
// the real code writes today. For each symptom with observability/fixtures/<code>/chain/hops.json, in hop order, it sets the
// hop's files aside, runs the hop's command with CHALK_CHAIN_WRITE=1, and compares each file the hop wrote with the one set aside
// (parsed JSON, so formatting doesn't count). A hop that fails, skips, or doesn't write a file it declares fails the replay, and
// every file set aside is put back whatever happens, so the working tree ends as it started.
//
//   node scripts/gates/obs-chain-replay.mjs [code ...]
//
// The hops need the SDK's dependencies, the Go toolchain, Elixir, and Postgres through scripts/gates/with-postgres.sh.
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { chainHops } from "./obs-coverage.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** @param {string} path */
const parsed = (path) => JSON.parse(readFileSync(path, "utf8"));

/**
 * Replays one chain and returns its problems; an empty list means every file is current.
 * @param {string} code
 * @returns {string[]}
 */
function replay(code) {
  const hops = chainHops(root, code) ?? [];
  const problems = [];
  for (const hop of hops) {
    const aside = hop.writes.map((file) => ({ file, path: join(root, file), kept: `${join(root, file)}.replay` }));
    for (const entry of aside) renameSync(entry.path, entry.kept);
    try {
      execSync(hop.command, { cwd: root, stdio: "inherit", env: { ...process.env, CHALK_CHAIN_WRITE: "1" }, shell: "/bin/bash" });
      for (const entry of aside) {
        if (!existsSync(entry.path)) problems.push(`${code} hop ${hop.hop} did not write ${entry.file}: it skipped or never reached its write`);
        else if (!isDeepStrictEqual(parsed(entry.path), parsed(entry.kept))) problems.push(`${code} hop ${hop.hop} wrote a different ${entry.file}: the committed file is stale or hand-edited`);
      }
    } catch (error) {
      problems.push(`${code} hop ${hop.hop} failed: ${hop.command} (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`);
    } finally {
      for (const entry of aside) renameSync(entry.kept, entry.path);
    }
    if (problems.length > 0) break;
  }
  return problems;
}

const codes = process.argv.length > 2 ? process.argv.slice(2) : readdirSync(join(root, "observability/fixtures")).filter((code) => chainHops(root, code) !== null);
const problems = codes.flatMap(replay);
if (problems.length > 0) {
  console.error(`Chain replay failed:\n${problems.map((problem) => `  ${problem}`).join("\n")}`);
  process.exit(1);
}
console.log(`Chain replay: ${codes.join(", ")} wrote exactly the committed files.`);
