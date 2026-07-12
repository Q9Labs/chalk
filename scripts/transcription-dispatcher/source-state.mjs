#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(process.argv[2] ?? process.cwd());
const scopes = process.argv.slice(3);
if (scopes.length === 0) throw new Error("source scopes are required");

function git(args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "buffer" });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const status = git(["status", "--porcelain=v1", "--untracked-files=all", "--", ...scopes]).toString("utf8");
if (status.length === 0) {
  process.stdout.write(JSON.stringify({ source_state: "clean" }));
  process.exit(0);
}

const trackedDiffDigest = sha256(git(["diff", "--no-ext-diff", "--binary", "HEAD", "--", ...scopes]));
const untrackedPaths = git(["ls-files", "--others", "--exclude-standard", "-z", "--", ...scopes])
  .toString("utf8")
  .split("\0")
  .filter(Boolean)
  .sort();
const untrackedFiles = untrackedPaths.map((path) => ({ path, sha256: sha256(readFileSync(resolve(root, path))) }));
const untrackedDigest = sha256(untrackedFiles.map((file) => `${file.path}\0${file.sha256}\n`).join(""));
const sourceTreeDigest = sha256(`tracked-diff\0${trackedDiffDigest}\nuntracked\0${untrackedDigest}\n`);
process.stdout.write(JSON.stringify({ source_state: "dirty-local-proof", source_tree_digest: sourceTreeDigest }));
