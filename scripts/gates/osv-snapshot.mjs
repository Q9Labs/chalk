import { copyFileSync, lstatSync, readdirSync, realpathSync, unlinkSync } from "node:fs";
import path from "node:path";

// The archive contains only tracked content. Never follow a link out of that view.
const root = realpathSync(process.argv[2]);
for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
  if (!entry.isSymbolicLink()) continue;
  const file = path.join(entry.parentPath, entry.name);
  const target = realpathSync(file);
  if (!target.startsWith(`${root}${path.sep}`) || !lstatSync(target).isFile()) throw new Error(`OSV cannot scan tracked symlink ${file}: target must be a tracked regular file inside the repository.`);
  unlinkSync(file);
  copyFileSync(target, file);
}
