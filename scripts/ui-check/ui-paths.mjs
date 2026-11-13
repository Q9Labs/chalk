// Decides whether a pull request changes UI. The UI check runs only when it does.
//   node scripts/ui-check/ui-paths.mjs <base-ref>   prints `ui=true` or `ui=false`
import { execFileSync } from "node:child_process";

export const UI_PATHS = [
  "apps/web/src",
  "apps/web/public",
  "apps/web/call-states.html",
  "apps/web/pre-join-states.html",
  "apps/web/vite.aliases.ts",
  "apps/web/vite.call-states.config.ts",
  "packages/ui",
  "packages/assets",
  "packages/facehash",
  "packages/whiteboard",
  "packages/transcript-language",
  "packages/recording-presentation",
  "sdks/typescript/react",
  "sdks/typescript/client/src",
  "scripts/ui-check",
  "pnpm-lock.yaml",
];

const NOT_VISIBLE = /\.(md|mdx)$|\.test\.[cm]?[jt]sx?$|(^|\/)(docs|__tests__)\//u;

/** @param {readonly string[]} files */
export function changesUi(files) {
  return files.some((file) => UI_PATHS.some((prefix) => file === prefix || file.startsWith(`${prefix}/`)) && !NOT_VISIBLE.test(file));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const base = process.argv[2] ?? "origin/master";
  const files = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  console.log(`ui=${changesUi(files)}`);
}
