import { chmodSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

const [rendererPath, ...extra] = process.argv.slice(2);
if (!rendererPath || extra.length) {
  throw new Error("usage: normalize-renderer-permissions.mjs <installed-renderer-directory>");
}

function normalize(path) {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    chmodSync(path, 0o755);
    for (const entry of readdirSync(path)) normalize(join(path, entry));
    return;
  }
  if (info.isFile()) {
    chmodSync(path, (info.mode & 0o111) === 0 ? 0o644 : 0o755);
    return;
  }
  throw new Error(`unsupported renderer artifact type: ${path}`);
}

if (!lstatSync(rendererPath).isDirectory()) {
  throw new Error("installed renderer path must be a directory");
}
normalize(rendererPath);
