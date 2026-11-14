// Decides whether Promote runs the MCP production check: only when the release changes MCP or what the check exercises.
// The diff is against the production release being replaced, not the previous commit. Anything unclear says "changed", because the check costs seconds.
//   node scripts/mcp-proof/changed.mjs --previous <sha> --target <sha>
// Prints "changed=true|false" and the reason; with GITHUB_OUTPUT set it also writes both there.
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const root = join(import.meta.dirname, "../..");
// The sign-in, API-key and Space-listing code behind the check's tool call, beyond the paths the feature map gives MCP itself.
export const dependencyPaths = [
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

export function checkedPaths(featureMap) {
  const mcp = featureMap.features.find((feature) => feature.name === "mcp");
  if (!mcp) throw new Error("features.json has no mcp feature");
  return [...mcp.paths, ...dependencyPaths];
}

export function pathsTouching(changedFiles, paths) {
  return changedFiles.filter((file) => paths.some((claim) => file === claim || file.startsWith(`${claim}/`)));
}

export function decide({ previous, target, cwd = root, featureMap = JSON.parse(readFileSync(join(root, "features.json"), "utf8")) }) {
  if (!previous || !target) return { changed: true, reason: "no previous production release to compare with" };
  const diff = spawnSync("git", ["diff", "--name-only", previous, target], { cwd, encoding: "utf8" });
  if (diff.status !== 0) return { changed: true, reason: `the diff ${previous.slice(0, 10)}..${target.slice(0, 10)} failed: ${diff.stderr.trim().slice(0, 200)}` };
  const touched = pathsTouching(diff.stdout.split("\n").filter(Boolean), checkedPaths(featureMap));
  if (touched.length === 0) return { changed: false, reason: `skipped: no change in MCP or its sign-in, API-key and Space paths since ${previous.slice(0, 10)}` };
  return { changed: true, reason: `${touched.length} changed file(s) in MCP paths, such as ${touched[0]}` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { previous: { type: "string" }, target: { type: "string" } } });
  const { changed, reason } = decide(values);
  console.log(`changed=${changed}\nreason=${reason}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\nreason=${reason}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `MCP production check: ${reason}\n`);
}
