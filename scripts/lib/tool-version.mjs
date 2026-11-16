#!/usr/bin/env node
// The version `.tool-versions` pins for a tool: `node scripts/lib/tool-version.mjs gitleaks`.
// Bash callers in CI use scripts/lib/tool-version.sh, which reads the same file.
import { readFileSync } from "node:fs";
import path from "node:path";
import { repositoryRoot } from "./repository.mjs";

/** @param {string} tool */
export function toolVersion(tool) {
  for (const line of readFileSync(path.join(repositoryRoot, ".tool-versions"), "utf8").split(/\r?\n/)) {
    const [name, version] = line.trim().split(/\s+/);
    if (name === tool && version) return version;
  }
  throw new Error(`No ${tool} line in .tool-versions`);
}

if (import.meta.main) {
  const tool = process.argv[2];
  if (!tool) {
    console.error("usage: tool-version.mjs <name>");
    process.exit(2);
  }
  console.log(toolVersion(tool));
}
