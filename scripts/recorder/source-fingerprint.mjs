#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readlink } from "node:fs/promises";
import path from "node:path";

import { fileSHA256 } from "./file-sha256.mjs";
import { runBoundedCommand } from "./run-bounded-command.mjs";

const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

function parseArguments(argv) {
  const scopes = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--scope") throw new Error(`unknown option: ${argv[index]}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error("--scope requires a path");
    scopes.push(value);
    index += 1;
  }
  return scopes;
}

async function git(arguments_, cwd) {
  const result = await runBoundedCommand("git", arguments_, { cwd, maxOutputBytes: MAX_GIT_OUTPUT_BYTES });
  return result.stdout;
}

function nulEntries(buffer) {
  return buffer
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry !== "");
}

function field(hash, value) {
  const encoded = Buffer.from(String(value), "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(encoded.length));
  hash.update(length);
  hash.update(encoded);
}

async function fingerprint(root, files, status) {
  const aggregate = createHash("sha256");
  let fileCount = 0;
  let sourceBytes = 0;
  for (const relative of files.sort()) {
    const absolute = path.resolve(root, relative);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new Error("git returned a path outside the worktree");
    let facts;
    try {
      facts = await lstat(absolute);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    let kind;
    let digest;
    let bytes;
    if (facts.isFile()) {
      kind = "file";
      digest = await fileSHA256(absolute);
      bytes = facts.size;
    } else if (facts.isSymbolicLink()) {
      kind = "symlink";
      const target = await readlink(absolute);
      digest = createHash("sha256").update(target).digest("hex");
      bytes = Buffer.byteLength(target);
    } else {
      continue;
    }
    field(aggregate, relative);
    field(aggregate, kind);
    field(aggregate, bytes);
    field(aggregate, digest);
    fileCount += 1;
    sourceBytes += bytes;
  }
  field(aggregate, "git-status-porcelain-v2");
  aggregate.update(status);
  return { bytes: sourceBytes, files: fileCount, sha256: aggregate.digest("hex") };
}

try {
  const requestedScopes = parseArguments(process.argv.slice(2));
  const root = (await git(["rev-parse", "--show-toplevel"], process.cwd())).toString("utf8").trim();
  const scopes = requestedScopes.map((scope) => {
    const absolute = path.resolve(process.cwd(), scope);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new Error("--scope must stay inside the worktree");
    return path.relative(root, absolute) || ".";
  });
  const pathspec = scopes.length === 0 ? [] : ["--", ...scopes];
  const [head, status, listed, unresolved] = await Promise.all([
    git(["rev-parse", "HEAD"], root),
    git(["status", "--porcelain=v2", "-z", "--untracked-files=all", ...pathspec], root),
    git(["ls-files", "-c", "-o", "--exclude-standard", "--deduplicate", "-z", ...pathspec], root),
    git(["diff", "--name-only", "--diff-filter=U", "-z", ...pathspec], root),
  ]);
  const source = await fingerprint(root, nulEntries(listed), status);
  const scopeHash = createHash("sha256");
  for (const scope of [...scopes].sort()) field(scopeHash, scope);
  const result = {
    evidence_version: "recording-source-evidence.v1",
    head: head.toString("utf8").trim(),
    clean: status.length === 0,
    unresolved_paths: nulEntries(unresolved).length,
    scope: {
      all: scopes.length === 0,
      count: scopes.length,
      sha256: scopeHash.digest("hex"),
    },
    status_sha256: createHash("sha256").update(status).digest("hex"),
    source,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.unresolved_paths !== 0) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
