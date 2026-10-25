import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export function assetFiles(entries: [source: string, relativePath: string][]) {
  return entries
    .flatMap(([source, relativePath]) => {
      if (!statSync(source).isDirectory()) return [{ path: relativePath, bytes: readFileSync(source) }];
      return readdirSync(source, { recursive: true, encoding: "utf8" })
        .filter((name) => statSync(join(source, name)).isFile())
        .map((name) => ({ path: join(relativePath, name).replaceAll("\\", "/"), bytes: readFileSync(join(source, name)) }));
    })
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

export function treeDigest(files: ReturnType<typeof assetFiles>): string {
  const hash = createHash("sha256");
  for (const { path, bytes } of files) hash.update(`${path}\0${bytes.byteLength}\0`).update(bytes);
  return hash.digest("hex").slice(0, 16);
}
