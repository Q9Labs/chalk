#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isMain } from "../script-entry.mjs";

const fixCommand = "pnpm install --frozen-lockfile";

// An npm alias such as `typescript-7: npm:typescript@7.0.1-rc` locks as `typescript@7.0.1-rc`;
// its installed manifest reports only the target version.
function aliasTargetVersion(version) {
  const alias = /^(?:@[^/@]+\/)?[^@:/]+@(\d\S*)$/.exec(version);
  return alias ? alias[1] : version;
}

// Lists the root importer's direct dependencies as { name, version } from pnpm-lock.yaml (lockfile v9).
export function rootLockedVersions(lockfileText) {
  const lines = lockfileText.split("\n");
  const start = lines.indexOf("  .:");
  if (start === -1) return [];
  const locked = [];
  let name;
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}\S/.test(line)) break;
    const entry = /^ {6}'?([^':]+(?:\/[^':]+)?)'?:$/.exec(line);
    if (entry) name = entry[1];
    const version = /^ {8}version: (\S+)$/.exec(line);
    if (version && name) locked.push({ name, version: aliasTargetVersion(version[1].replace(/\(.*$/, "")) });
  }
  return locked;
}

export function installMismatches(locked, readInstalledVersion) {
  const problems = [];
  for (const { name, version } of locked) {
    if (version.startsWith("link:")) continue;
    const installed = readInstalledVersion(name);
    if (installed === undefined) problems.push(`${name}: locked ${version}, not installed`);
    else if (version.startsWith("http") ? !version.endsWith(`-${installed}.tgz`) : version !== installed) problems.push(`${name}: locked ${version}, installed ${installed}`);
  }
  return problems;
}

function checkInstall(root) {
  if (!existsSync(join(root, "node_modules"))) return [`node_modules is missing`];
  const readInstalledVersion = (name) => {
    const manifest = join(root, "node_modules", name, "package.json");
    return existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")).version : undefined;
  };
  return installMismatches(rootLockedVersions(readFileSync(join(root, "pnpm-lock.yaml"), "utf8")), readInstalledVersion);
}

if (isMain(import.meta)) {
  const problems = checkInstall(process.cwd());
  if (problems.length > 0) {
    console.error(`Installed dependencies do not match pnpm-lock.yaml:\n${problems.map((problem) => `  - ${problem}`).join("\n")}\nRun \`${fixCommand}\` and retry.`);
    process.exit(1);
  }
}
