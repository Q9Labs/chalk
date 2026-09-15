import { existsSync, realpathSync } from "node:fs";

export const isMain = (meta) => {
  const entry = process.argv[1];
  return entry !== undefined && existsSync(entry) && realpathSync(entry) === meta.filename;
};
