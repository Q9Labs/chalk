import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { gitLines } from "../lib/git.mjs";
import { repositoryRoot } from "../lib/repository.mjs";

export function ratchetArgsFor({ scope, base, event, full }) {
  return !full && scope === "merge base to HEAD" && [undefined, "pull_request", "merge_group"].includes(event) ? ["--base", base] : [];
}

// A full lane plan is not necessarily a full-tree ratchet: a PR that changes the Gate still has a diff.
export function ratchetBase(args, env = process.env) {
  if (args.includes("--write")) return null;
  const baseFlag = args.indexOf("--base");
  if (baseFlag !== -1) {
    const ref = args[baseFlag + 1];
    if (!ref || ref.startsWith("-")) throw new Error("--base requires a Git ref");
    return gitLines(["merge-base", "--", "HEAD", ref])[0];
  }
  const event = env.GITHUB_EVENT_NAME;
  if (event !== "pull_request" && event !== "merge_group") return null;
  const groupBase = event === "merge_group" && !env.GATE_BASE_REF && env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")).merge_group.base_sha : null;
  const ref = env.GATE_BASE_REF || groupBase || `origin/${env.GITHUB_BASE_REF || "master"}`;
  return gitLines(["merge-base", "--", "HEAD", ref])[0];
}

export function changedPaths(base) {
  const output = execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", base, "--"], { cwd: repositoryRoot, encoding: "utf8" });
  return new Set(output.split("\0").filter(Boolean));
}
