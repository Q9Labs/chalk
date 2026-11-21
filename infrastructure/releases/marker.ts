import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// postDeployMarker reports an applied stack as one release.marker row. Posting
// runs through the shared script so it fails open: an infrastructure deploy is
// never failed by a marker that could not be delivered.
export function postDeployMarker(component: string, environment: string): void {
  let commit = process.env.GITHUB_SHA ?? "";
  if (!commit) {
    try {
      commit = execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
    } catch {
      commit = "unknown";
    }
  }
  try {
    execSync(
      `node ${JSON.stringify(resolve(root, "scripts/releases/release-marker.mjs"))} --component ${JSON.stringify(component)} --release-id ${JSON.stringify(commit)} --commit ${JSON.stringify(commit)} --kind deploy --environment ${JSON.stringify(environment)}`,
      { cwd: root, stdio: "inherit" },
    );
  } catch {
    // The marker script exits 0 on failure; a non-zero exit here means node itself failed.
  }
}
