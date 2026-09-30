import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Node resolves symlinks for the entry module, so import.meta.url names the real file while
// argv[1] keeps the path it was started with (for example /opt/chalk-recorder/current/...).
export function isMainModule(moduleUrl: string, entryPath: string | undefined = process.argv[1]): boolean {
  if (entryPath === undefined) return false;
  return realpathSync(entryPath) === fileURLToPath(moduleUrl);
}
