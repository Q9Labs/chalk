import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { repositoryRoot } from "./repository.mjs";

/** Public packages that version on their own. Every other public package moves with the Chalk release version. */
const independentPackageNames = new Set(["@q9labsai/recording-presentation"]);

function deriveReleasePackages(workspaces) {
  const byName = new Map(workspaces.map((workspace) => [workspace.manifest.name, workspace]));
  const publicWorkspaces = workspaces.filter(({ manifest }) => manifest.private !== true);
  for (const { manifest } of publicWorkspaces) {
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies })) {
      if (byName.get(name)?.manifest.private === true) {
        throw new Error(`${manifest.name} has a runtime dependency on private workspace ${name}`);
      }
    }
  }
  return publicWorkspaces.map(({ directory, manifest }) => ({ directory, name: manifest.name, version: manifest.version, independent: independentPackageNames.has(manifest.name) }));
}

const workspaces = JSON.parse(execFileSync("pnpm", ["--recursive", "list", "--depth", "-1", "--json"], { cwd: repositoryRoot, encoding: "utf8" })).map((workspace) => ({
  directory: path.relative(repositoryRoot, workspace.path),
  manifest: JSON.parse(readFileSync(path.join(workspace.path, "package.json"), "utf8")),
}));

export const releasePackages = Object.freeze(deriveReleasePackages(workspaces));
export const chalkReleaseVersion = releasePackages.find(({ independent }) => !independent).version;
