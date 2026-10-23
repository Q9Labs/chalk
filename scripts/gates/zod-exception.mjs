import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAll } from "js-yaml";

const label = (key) => key.split("(")[0];
const dependencyGroups = ["dependencies", "devDependencies", "optionalDependencies"];

// Apply the exception to OSV's findings only after verifying this tooling tail:
// apps/mobile -> ... -> expo@55.0.9 -> @expo/cli@55.0.19 -> zod@3.25.76.
// sdks/typescript/react-native also reaches that tail through its Expo native peers.
// Expo's native modules also depend on expo, so ancestors before expo can cycle.
const allowedImporters = new Set(["importer:apps/mobile", "importer:sdks/typescript/react-native"]);
function checkZodException(source) {
  for (const document of loadAll(source)) {
    if (document?.lockfileVersion !== "9.0") throw new Error(`Zod exception only supports pnpm lockfileVersion 9.0; found ${document?.lockfileVersion ?? "missing"}. Regenerate the root lockfile with the pinned pnpm version, or extend and re-check this guard before changing its supported format.`);
    const { importers = {}, snapshots = {}, packages = {} } = document;
    const parents = new Map();
    const importerKey = (name) => `importer:${name}`;
    for (const [name, node] of [...Object.entries(importers), ...Object.entries(snapshots)]) {
      const importer = Object.hasOwn(importers, name);
      const parent = importer ? importerKey(name) : name;
      for (const group of dependencyGroups) {
        for (const [dependency, value] of Object.entries(node[group] ?? {})) {
          const reference = importer ? value.version : value;
          const target = reference.startsWith("link:")
            ? importerKey(path.posix.normalize(path.posix.join(name, reference.slice(5))))
            : Object.hasOwn(snapshots, reference)
              ? reference // npm aliases use the real package name in their reference.
              : `${dependency}@${reference}`;
          if (!parents.has(target)) parents.set(target, []);
          parents.get(target).push(parent);
        }
      }
    }

    for (const key of new Set([...Object.keys(packages), ...Object.keys(snapshots), ...parents.keys()])) {
      if (!key.startsWith("zod@")) continue;
      const version = label(key).slice(4);
      const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)?.slice(1).map(Number);
      const fixed = parts && (parts[0] > 4 || (parts[0] === 4 && (parts[1] > 6 || (parts[1] === 6 && parts[2] >= 6))));
      if (fixed) continue;
      if (version !== "3.25.76") throw new Error(`Zod exception rejects ${key}; use zod >=4.6.6.`);

      const queue = [[key]];
      const visited = new Set();
      let foundImporter = false;
      for (const chain of queue) {
        const current = chain[0];
        if (visited.has(current)) continue;
        visited.add(current);
        const incoming = parents.get(current);
        if (!incoming?.length) throw new Error(`Zod exception cannot account for ${chain.map(label).join(" -> ")}`);
        for (const parent of incoming) {
          const expected = chain.length === 1 ? "@expo/cli@55.0.19" : chain.length === 2 ? "expo@55.0.9" : null;
          if (expected && label(parent) !== expected) throw new Error(`Zod exception rejects ${[parent, ...chain].map(label).join(" -> ")}`);
          if (parent.startsWith("importer:")) {
            if (!allowedImporters.has(parent)) throw new Error(`Zod exception rejects ${[parent, ...chain].map(label).join(" -> ")}`);
            foundImporter = true;
            if (parents.has(parent)) queue.push([parent, ...chain]);
            continue;
          }
          queue.push([parent, ...chain]);
        }
      }
      if (!foundImporter) throw new Error(`Zod exception has no allowed importer for ${key}`);
    }
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [lockfile, reportFile] = process.argv.slice(2);
    checkZodException(readFileSync(lockfile, "utf8"));
    if (reportFile) {
      const report = JSON.parse(readFileSync(reportFile, "utf8"));
      const advisory = "GHSA-mrhx-c7xc-m3w5";
      for (const result of report.results ?? []) {
        console.log(`OSV input: ${path.relative(process.cwd(), result.source.path)}`);
        for (const entry of result.packages ?? []) {
          entry.vulnerabilities = (entry.vulnerabilities ?? []).filter((vulnerability) => {
            if (vulnerability.id !== advisory && !vulnerability.aliases?.includes(advisory)) return true;
            const { name, ecosystem, version } = entry.package;
            if (result.source.type !== "lockfile" || path.resolve(result.source.path) !== path.resolve(lockfile) || name !== "zod" || ecosystem !== "npm" || version !== "3.25.76")
              throw new Error(`Zod exception rejects OSV finding ${vulnerability.id}: ${result.source.path} ${ecosystem} ${name}@${version}`);
            if (Date.now() >= Date.parse("2026-11-22T00:00:00Z")) throw new Error("Zod tooling exception expired on 2026-11-22.");
            console.log(`Zod tooling exception accepted: ${result.source.path} ${name}@${version} (expires 2026-11-22)`);
            return false;
          });
        }
      }
      writeFileSync(reportFile, JSON.stringify(report));
    }
  } catch (error) {
    console.error(error.message);
    console.error(
      "If Expo or zod changed, re-check that the old zod copy reaches only Expo CLI tooling and is absent from runtime bundles. Then update the allowed versions in scripts/gates/zod-exception.mjs, the regression fixtures, and the exception's reason in osv-scanner.toml. Remove the exception when a fixed dependency makes it unnecessary.",
    );
    process.exitCode = 1;
  }
}
