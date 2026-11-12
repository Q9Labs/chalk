import { readFileSync } from "node:fs";

// The checks register is the one list of every check Chalk runs. The Gate builds its lanes from it, so a lane cannot exist without
// an entry; scripts/gates/check-register.mjs fails when a workflow job, hook command or budget group has none.
export const registerPath = new URL("./checks.json", import.meta.url);

export function readRegister() {
  return JSON.parse(readFileSync(registerPath, "utf8")).checks;
}

/** gateTaskIds lists the planner tasks in run order. Lanes that q9gate provides itself (scope, depcruise, design-tokens) are marked builtin. */
export function gateTaskIds() {
  return readRegister()
    .filter((entry) => entry.id.startsWith("gate:") && !entry.builtin)
    .map((entry) => entry.id.slice("gate:".length));
}

export function requireRegistered(taskId) {
  if (!gateTaskIds().includes(taskId)) {
    throw new Error(`Gate task "${taskId}" has no entry in scripts/gates/checks.json. Add one with its purpose, owner, run points and consequence.`);
  }
}
