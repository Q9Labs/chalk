#!/usr/bin/env node
// Direct release-export scanner CLI, documented in the harness README.
// fallow-ignore-file unused-file
import { readdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const root = resolve(process.argv[2] ?? "dist");
const markers = ["Unknown mockup code:", "fixture-episode", "Harness stand-in", "Missing measured testID:", "preview-microphone-backup"];
let bundles = 0;
async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await inspect(path);
    else if (/\.(js|hbc)$/.test(entry.name)) {
      bundles++;
      const source = await readFile(path);
      for (const marker of markers) if (source.includes(Buffer.from(marker)) || source.includes(Buffer.from(marker, "utf16le"))) throw new Error(`Harness code in release bundle ${path}: ${marker}`);
    }
  }
}
await inspect(root);
if (!bundles) throw new Error(`No release bundles under ${root}; export both platforms first`);
console.log(`PASS: ${bundles} release bundles contain no harness markers`);
