import { execFileSync } from "node:child_process";
import { copyFileSync, lstatSync, mkdirSync, readdirSync, realpathSync, unlinkSync } from "node:fs";
import path from "node:path";

const destination = realpathSync(process.argv[2]);
const workingTree = process.argv[3] === "--working-tree";
const root = workingTree ? realpathSync(process.cwd()) : destination;
const files = new Set(workingTree ? execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean) : readdirSync(root, { recursive: true, withFileTypes: true }).map((entry) => path.relative(root, path.join(entry.parentPath, entry.name))));
for (const relative of files) {
  const file = path.join(root, relative);
  let entry;
  try {
    entry = lstatSync(file);
  } catch (error) {
    if (workingTree && error.code === "ENOENT") continue; // A tracked working-tree deletion.
    throw error;
  }
  if (!workingTree && !entry.isSymbolicLink()) continue;
  // Resolve only tracked regular-file targets, never untracked or external content.
  const target = realpathSync(file);
  if (!target.startsWith(`${root}${path.sep}`) || (workingTree && !files.has(path.relative(root, target))) || !lstatSync(target).isFile()) throw new Error(`OSV cannot scan tracked path ${file}: target must be a tracked regular file inside the repository.`);
  const output = path.join(destination, relative);
  if (workingTree) mkdirSync(path.dirname(output), { recursive: true });
  else unlinkSync(file);
  copyFileSync(target, output);
}
