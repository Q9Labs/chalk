import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { readTracker, repoRoot } from "./tracker-data.mjs";
import { renderMarkdown } from "./tracker-render.mjs";

const [flag, ...rest] = process.argv.slice(2);
if ((flag !== undefined && flag !== "--check") || rest.length) throw new Error(`Unknown or incomplete argument: ${rest[0] ?? flag}`);
const check = flag === "--check";

const tracker = await readTracker();
const output = path.join(repoRoot, "tracker-human.md");
const contents = renderMarkdown(tracker);
if (check) {
  if ((await readFile(output, "utf8")) !== contents) throw new Error("tracker-human.md is stale; run pnpm generate:tracker");
} else {
  await writeFile(output, contents);
}
console.log(`${check ? "Current" : "Generated"} tracker view: ${tracker.outcomes.length} outcomes.`);
