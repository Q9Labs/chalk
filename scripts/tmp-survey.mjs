import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

mkdirSync("/tmp/ci-lane/wf", { recursive: true });
for (const name of ["ci", "hotfix", "promote", "mcp-production-check", "rollback-rehearsal", "real-call-proof", "web-call-proof"]) {
  const text = execFileSync("git", ["show", `origin/master:.github/workflows/${name}.yml`], { encoding: "utf8" });
  writeFileSync(`/tmp/ci-lane/wf/${name}.yml`, text);
}
