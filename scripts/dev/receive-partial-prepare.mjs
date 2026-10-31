import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const baseline = "3f9fe4385eb3ba000953b6b0198ddc705c508db9";
const fixed = execFileSync("git", ["rev-parse", process.env.CHALK_PARTIAL_FIX_REF || "HEAD"], { encoding: "utf8" }).trim();
export const revisions = {
  server: fixed,
  ...Object.fromEntries(
    [1, 2, 3].flatMap((run) => [
      [`master-${run}`, baseline],
      [`fixed-${run}`, fixed],
    ]),
  ),
};
if (process.argv[1] === import.meta.filename) {
  for (const [version, revision] of Object.entries(revisions)) {
    if (version === "server") continue;
    const destination = resolve(".private/receive-partial", version);
    await mkdir(destination, { recursive: true });
    const archive = execFileSync("git", ["archive", revision, "sdks/typescript/client", "sdks/typescript/react"], { maxBuffer: 100 * 1024 * 1024 });
    execFileSync("tar", ["-xf", "-", "-C", destination], { input: archive });
  }
  await writeFile(".private/receive-partial/revisions.json", JSON.stringify(revisions, null, 2));
  console.log("Prepared fixed source revisions.");
}
