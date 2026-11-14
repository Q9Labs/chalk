import { execFileSync } from "node:child_process";
import { repositoryRoot } from "./repository.mjs";

/** gitLines runs git and returns its trimmed, non-empty output lines. */
export function gitLines(args, { cwd = repositoryRoot, env = process.env } = {}) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
