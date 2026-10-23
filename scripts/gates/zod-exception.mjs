import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAll } from "js-yaml";

const label = (key) => key.split("(")[0];
const dependencyGroups = ["dependencies", "devDependencies", "optionalDependencies"];

// OSV ignores advisory IDs, not importer paths. Permit only this tooling tail:
// apps/mobile -> ... -> expo@55.0.9 -> @expo/cli@55.0.19 -> zod@3.25.76.
// sdks/typescript/react-native also reaches that tail through its Expo native peers.
// Expo's native modules also depend on expo, so ancestors before expo can cycle.
const allowedImporters = new Set(["importer:apps/mobile", "importer:sdks/typescript/react-native"]);
export function checkZodException(source) {
  for (const document of loadAll(source)) {
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
    for (const lockfile of process.argv.slice(2)) checkZodException(readFileSync(lockfile, "utf8"));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
