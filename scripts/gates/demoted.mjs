import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readRegister } from "./register.mjs";

/** demotedNotice is the warning a demoted check prints when it fails: why it does not block, the runs that earned the demotion and the issue that brings it back. */
export function demotedNotice(entry) {
  const { reason, runs, issue } = entry.demoted;
  return `${entry.id} failed and is demoted, so it does not fail the gate. ${reason} It failed with no product cause in runs ${runs.join(" and ")}. Fix it, then delete the demoted field: ${issue}`;
}

/** runDemoted runs the check and returns 0 whatever it exits with; a failure is reported as a warning. */
export function runDemoted(entry, command) {
  const result = spawnSync(command[0], command.slice(1), { stdio: "inherit" });
  if (result.status === 0) return 0;
  console.log(`::warning title=Demoted check ${entry.id} failed::${demotedNotice(entry)}`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [id, separator, ...command] = process.argv.slice(2);
  const entry = readRegister().find((candidate) => candidate.id === id);
  if (!entry?.demoted || separator !== "--" || command.length === 0) {
    console.error("usage: node scripts/gates/demoted.mjs <register id of a demoted check> -- <command...>");
    process.exit(2);
  }
  process.exit(runDemoted(entry, command));
}
