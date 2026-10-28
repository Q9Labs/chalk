#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

// Reasons in this file are only for the component owned by the separate audio
// type-safety change. Do not rewrite its suppressions from this audit.
const audioReasons = [
  ["subscription", "Retry blocked playback on user gestures; remove unlock listeners when no retry is needed."],
  ["resource", "Reconcile microphone audio elements without recreating them on render; detach only departed tracks."],
  ["resource", "Pause and detach microphone audio elements only when the output owner unmounts."],
  ["subscription", "Observe microphone track ended events; remove each track listener on replacement."],
  ["resource", "Reconcile screen-share audio elements without interrupting continuing tracks."],
  ["resource", "Pause and detach screen-share audio elements only when the output owner unmounts."],
];
const categories = new Set(["resource", "subscription", "timer", "dom", "animation", "transition", "development"]);
const root = resolve(import.meta.dirname, "../..");
const entries = [];
async function visit(directory) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await visit(path);
    else if (/\.tsx?$/.test(entry.name)) {
      const file = relative(root, path);
      let ordinal = 0;
      const lines = (await readFile(path, "utf8")).split("\n");
      for (const [index, line] of lines.entries()) {
        if (!line.includes("ast-grep-ignore: chalk.forbid-sdk-use-effect-")) continue;
        ordinal++;
        const protectedAudio = file === "sdks/typescript/react/src/components/audio-output/AudioOutput.tsx";
        const reason = line.match(/ -- \[([a-z]+)\] (.+)$/);
        const [category, explanation] = protectedAudio ? (audioReasons[ordinal - 1] ?? []) : (reason?.slice(1) ?? []);
        if (!categories.has(category) || !explanation) throw new Error(`${file}:${index + 1}: classify the effect and describe its synchronization/lifetime`);
        entries.push({ file, line: index + 1, ordinal, category, reason: explanation, protectedAudio });
      }
      if (file.endsWith("/audio-output/AudioOutput.tsx") && ordinal !== audioReasons.length) throw new Error("AudioOutput effects changed; re-audit its ownership boundary");
    }
  }
}
await visit(resolve(root, "sdks/typescript/react/src"));
await visit(resolve(root, "sdks/typescript/react-native/src"));
const counts = Object.fromEntries([...categories].map((category) => [category, entries.filter((entry) => entry.category === category).length]));
if (process.argv.includes("--json")) console.log(JSON.stringify({ total: entries.length, counts, entries }, null, 2));
else if (process.argv.includes("--markdown")) {
  console.log("| File and current line | Category | Reason |\n| --- | --- | --- |");
  for (const entry of entries) console.log(`| [${entry.file}:${entry.line}](../${entry.file}#L${entry.line})${entry.protectedAudio ? " (protected)" : ""} | ${entry.category} | ${entry.reason} |`);
} else {
  console.log(`SDK effect suppressions: ${entries.length}`);
  for (const [category, count] of Object.entries(counts)) console.log(`${category}: ${count}`);
}
