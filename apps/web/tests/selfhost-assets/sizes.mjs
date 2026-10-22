import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

const [label, destination] = process.argv.slice(2);
const root = resolve("apps/web/dist/client");
const files = [];
for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || entry.parentPath.includes("_worker.js")) continue;
  const path = resolve(entry.parentPath, entry.name);
  const bytes = await readFile(path);
  files.push({ path: path.slice(root.length + 1), bytes: bytes.length, gzip: gzipSync(bytes).length });
}
await writeFile(resolve(destination, `${label}-sizes.json`), JSON.stringify(files, null, 2));
