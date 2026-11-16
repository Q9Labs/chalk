#!/usr/bin/env node
// File commands for package.json scripts, so they run the same under cmd.exe, PowerShell and sh.
//
//   node scripts/fs.mjs rm <path>...      like rm -rf: removes files and folders, and ignores a missing path
//   node scripts/fs.mjs mkdir <path>...   like mkdir -p
//   node scripts/fs.mjs cp <from> <to>    like cp -R: a `to` that ends in a slash, or is an existing folder, receives `from` inside it
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const [command, ...paths] = process.argv.slice(2);

if (command === "rm" && paths.length > 0) {
  for (const target of paths) rmSync(target, { recursive: true, force: true });
} else if (command === "mkdir" && paths.length > 0) {
  for (const target of paths) mkdirSync(target, { recursive: true });
} else if (command === "cp" && paths.length === 2) {
  const [from, to] = paths;
  const intoFolder = /[\\/]$/.test(to) || (existsSync(to) && statSync(to).isDirectory());
  const target = intoFolder ? path.join(to, path.basename(from)) : to;
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(from, target, { recursive: true });
} else {
  console.error("usage: fs.mjs rm <path>... | mkdir <path>... | cp <from> <to>");
  process.exit(2);
}
