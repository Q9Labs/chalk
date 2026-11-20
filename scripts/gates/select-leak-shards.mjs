#!/usr/bin/env node
// Picks the newest attempt's leak shard report for each shard from a downloaded artifact directory
// and copies them to the target directory as call-leaks-1.json .. call-leaks-N.json.
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SHARD_DIR = /^call-leaks-(\d+)(?:-attempt-(\d+))?$/u;

export function selectLeakShards(sourceDir, outDir, shardCount = 3) {
  const winners = new Map();
  if (existsSync(sourceDir)) {
    for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const match = SHARD_DIR.exec(entry.name);
      if (!match) continue;
      const shard = Number(match[1]);
      const attempt = match[2] ? Number(match[2]) : 0;
      const reportPath = join(sourceDir, entry.name, `call-leaks-${shard}.json`);
      if (!existsSync(reportPath)) continue;
      const prev = winners.get(shard);
      if (!prev || attempt > prev.attempt) winners.set(shard, { attempt, reportPath });
    }
  }
  const missing = [];
  for (let shard = 1; shard <= shardCount; shard++) {
    if (!winners.has(shard)) missing.push(shard);
  }
  if (missing.length) {
    throw new Error(`Missing leak shard report(s): ${missing.map((s) => `call-leaks-${s}`).join(", ")}`);
  }
  mkdirSync(outDir, { recursive: true });
  const selected = [];
  for (let shard = 1; shard <= shardCount; shard++) {
    const dest = join(outDir, `call-leaks-${shard}.json`);
    copyFileSync(winners.get(shard).reportPath, dest);
    selected.push({ shard, attempt: winners.get(shard).attempt, dest });
  }
  return selected;
}

if (import.meta.main) {
  const [sourceDir, outDir, countArg] = process.argv.slice(2);
  if (!sourceDir || !outDir) {
    console.error("Usage: select-leak-shards.mjs <source-dir> <out-dir> [shard-count]");
    process.exit(2);
  }
  try {
    const selected = selectLeakShards(sourceDir, outDir, countArg ? Number(countArg) : 3);
    for (const { shard, attempt } of selected) {
      console.log(`Selected call-leaks-${shard}.json from attempt ${attempt}`);
    }
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
