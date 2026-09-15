import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isMain } from "./script-entry.mjs";
import { readTracker, repoRoot } from "./tracker-data.mjs";
import { renderHtml, renderMarkdown } from "./tracker-render.mjs";

export const generateTracker = async ({ root = repoRoot, check = false } = {}) => {
  const tracker = await readTracker(root);
  const outputs = [
    ["tracker-human.md", renderMarkdown(tracker)],
    ["tracker-human.html", renderHtml(tracker)],
  ];
  if (check) {
    for (const [file, expected] of outputs) {
      const actual = await readFile(path.join(root, file), "utf8");
      if (actual !== expected) throw new Error(`${file} is stale; run pnpm generate:tracker`);
    }
  } else {
    for (const [file, contents] of outputs) await writeFile(path.join(root, file), contents);
  }
  return tracker;
};

if (isMain(import.meta)) {
  const args = process.argv.slice(2);
  let root = repoRoot;
  let check = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--check") check = true;
    else if (args[i] === "--root" && args[i + 1] && !args[i + 1].startsWith("--")) root = path.resolve(args[++i]);
    else throw new Error(`Unknown or incomplete argument: ${args[i]}`);
  }
  const tracker = await generateTracker({ root, check });
  console.log(`${check ? "Current" : "Generated"} tracker views: ${tracker.outcomes.length} outcomes.`);
}
