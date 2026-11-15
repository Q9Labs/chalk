// Decides whether the release changes MCP or what the MCP production check exercises (scripts/mcp-proof/changed.mjs prints the answer).
// The diff is against the production release being replaced, not the previous commit. Anything unclear says "changed", because the check costs seconds.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "../..");
// The sign-in, API-key and Space-listing code behind the check's tool call, beyond the paths the feature map gives MCP itself.
const dependencyPaths = [
  "apps/api/internal/apikeys",
  "apps/api/internal/authentication",
  "apps/api/internal/authorization",
  "apps/api/internal/spaces",
  "apps/api/internal/httpapi/api_keys.go",
  "apps/api/internal/httpapi/authorization.go",
  "apps/api/internal/httpapi/middleware.go",
  "apps/api/internal/httpapi/request_credentials.go",
  "apps/api/internal/httpapi/spaces.go",
];

function checkedPaths(featureMap) {
  const mcp = featureMap.features.find((feature) => feature.name === "mcp");
  if (!mcp) throw new Error("features.json has no mcp feature");
  return [...mcp.paths, ...dependencyPaths];
}

function pathsTouching(changedFiles, paths) {
  return changedFiles.filter((file) => paths.some((claim) => file === claim || file.startsWith(`${claim}/`)));
}

// changedFiles lists what differs between two releases, or says why that cannot be known so the check runs.
function changedFiles({ previous, target, cwd }) {
  if (!previous || !target) return { reason: "no previous production release to compare with" };
  const diff = spawnSync("git", ["diff", "--name-only", previous, target], { cwd, encoding: "utf8" });
  if (diff.status !== 0) return { reason: `the diff ${previous.slice(0, 10)}..${target.slice(0, 10)} failed: ${diff.stderr.trim().slice(0, 200)}` };
  return { files: diff.stdout.split("\n").filter(Boolean) };
}

export function decide({ previous, target, cwd = root, featureMap = JSON.parse(readFileSync(join(root, "features.json"), "utf8")) }) {
  const { files, reason } = changedFiles({ previous, target, cwd });
  if (!files) return { changed: true, reason };
  const touched = pathsTouching(files, checkedPaths(featureMap));
  if (touched.length === 0) return { changed: false, reason: `skipped: no change in MCP or its sign-in, API-key and Space paths since ${previous.slice(0, 10)}` };
  return { changed: true, reason: `${touched.length} changed file(s) in MCP paths, such as ${touched[0]}` };
}
