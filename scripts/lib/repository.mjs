import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const repositoryRoot = resolve(import.meta.dirname, "../..");

/** The pnpm release that package.json packageManager names, such as "12.8.1". */
export const pnpmVersion = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8")).packageManager.replace(/^pnpm@/, "");
