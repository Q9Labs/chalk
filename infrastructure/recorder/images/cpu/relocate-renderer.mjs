import { readdirSync, readlinkSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

const [rendererPath, sourcePath, ...extra] = process.argv.slice(2);
if (!rendererPath || !sourcePath || extra.length) {
  throw new Error("usage: relocate-renderer.mjs <deployed-renderer> <source-renderer>");
}
const renderer = realpathSync(rendererPath);
const source = realpathSync(sourcePath);
if (renderer === source) throw new Error("deployed renderer must differ from source");

function collectLinks(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) return [path];
    return entry.isDirectory() ? collectLinks(path) : [];
  });
}

const links = collectLinks(renderer);
for (const link of links) {
  // pnpm's legacy deploy leaves its package self-link pointing at the checkout.
  if (realpathSync(link) === source) {
    unlinkSync(link);
    symlinkSync(relative(dirname(link), renderer), link);
  }
}
for (const link of links) {
  const target = readlinkSync(link);
  const resolved = realpathSync(link);
  if (isAbsolute(target) || (resolved !== renderer && !resolved.startsWith(renderer + sep))) {
    throw new Error(`deployed renderer link escapes its release: ${relative(renderer, link)}`);
  }
}
