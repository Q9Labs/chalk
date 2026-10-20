#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const packageName = "@q9labsai/chalk-client";
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function maintenanceTag({ ref, sha, checkedOutSha, liveSha, manifest, expectedVersion, versions }) {
  const line = /^refs\/heads\/release\/client-(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(ref);
  if (!line) throw new Error("Dispatch must target a release/client-X.Y branch");
  if (!/^[0-9a-f]{40}$/.test(liveSha) || sha !== liveSha || checkedOutSha !== liveSha) {
    throw new Error("Dispatch and checkout must both equal the live release branch head");
  }
  const version = stableVersion.exec(manifest.version);
  if (manifest.name !== packageName || !version || manifest.version !== expectedVersion) {
    throw new Error("Client manifest must match the explicit stable client_version input");
  }
  if (version[1] !== line[1] || version[2] !== line[2]) throw new Error("Client version must match the release branch line");
  let tag = "latest";
  for (const published of versions) {
    const sameLine = stableVersion.exec(published);
    if (sameLine && sameLine[1] === line[1] && sameLine[2] === line[2] && BigInt(sameLine[3]) >= BigInt(version[3])) {
      throw new Error(`Client version must exceed every published stable version on ${line[1]}.${line[2]}`);
    }
    // Include prereleases: even an upcoming newer line must not lose its latest tag.
    const publishedLine = /^(\d+)\.(\d+)\./.exec(published);
    if (publishedLine && (BigInt(publishedLine[1]) > BigInt(line[1]) || (publishedLine[1] === line[1] && BigInt(publishedLine[2]) > BigInt(line[2])))) tag = `release-${line[1]}.${line[2]}`;
  }
  return tag;
}

async function main() {
  const mode = process.argv[2];
  if (!["--plan", "--publish"].includes(mode)) throw new Error("Use --plan or --publish");
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
  const ref = process.env.GITHUB_REF ?? "";
  if (!/^refs\/heads\/release\/client-\d+\.\d+$/.test(ref)) throw new Error("Invalid maintenance dispatch ref");
  const manifest = JSON.parse(readFileSync("sdks/typescript/client/package.json", "utf8"));
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`npm metadata lookup failed: HTTP ${response.status}`);
  const metadata = await response.json();
  if (metadata.name !== packageName || !metadata.versions || typeof metadata.versions !== "object" || Array.isArray(metadata.versions)) {
    throw new Error("Invalid npm package metadata");
  }
  const tag = maintenanceTag({ ref, sha: process.env.GITHUB_SHA, checkedOutSha: git("rev-parse", "HEAD"), liveSha: git("ls-remote", "origin", ref).split(/\s+/)[0], manifest, expectedVersion: process.env.CLIENT_VERSION, versions: Object.keys(metadata.versions) });
  console.log(`CLIENT_DIST_TAG=${tag}`);
  if (mode === "--publish") {
    if (process.env.GITHUB_ACTIONS !== "true" || process.env.NPM_CONFIG_PROVENANCE !== "true") {
      throw new Error("Client publishing requires GitHub Actions and npm provenance");
    }
    execFileSync("pnpm", ["--filter", packageName, "publish", "--access", "public", "--no-git-checks", "--tag", tag], { stdio: "inherit" });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
