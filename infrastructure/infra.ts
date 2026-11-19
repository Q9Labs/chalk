import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkRegistry, cutoverStages, entryFile, registryTable, requireCutover, selectStack } from "./registry.ts";

const [operation, name, stageName, ...args] = process.argv.slice(2);
const cwd = fileURLToPath(new URL(".", import.meta.url));
if (operation === "list") {
  process.stdout.write(`${registryTable()}\n`);
} else if (operation === "cutovers") {
  process.stdout.write(`${JSON.stringify(cutoverStages())}\n`);
} else if (operation === "check") {
  checkRegistry();
} else if (operation === "table") {
  const file = new URL("README.md", import.meta.url);
  writeFileSync(file, readFileSync(file, "utf8").replace(/<!-- stacks:start -->[\s\S]*?<!-- stacks:end -->/, `<!-- stacks:start -->\n${registryTable()}\n<!-- stacks:end -->`));
} else {
  const stack = selectStack(name, stageName);
  const stage = stack.stage;
  if (!["plan", "deploy", "drift", "seed"].includes(operation ?? "")) throw new Error("Usage: pnpm infra <plan|deploy|drift|seed> <stack> <stage> [args]");
  if (operation === "deploy") requireCutover(stack);
  if (operation !== "seed" && args.length) throw new Error("Operations accept no overriding flags; configure inputs through the stack environment");
  if (operation === "seed" && (!args[0] || args[0].startsWith("-") || args.length > 2 || (args[1] !== undefined && args[1] !== "--dry-run"))) throw new Error("Seed requires a private state file and optional --dry-run");
  const command = operation === "seed" ? ["tsx", "migration/seed.ts", stack.name, stage, ...args]
    : stack.name === "transcription-dispatcher" && operation !== "drift" ? ["tsx", "releases/driver.ts", operation === "deploy" ? "cutover" : "plan", stage, ...args]
    : operation === "deploy" ? ["tsx", "releases/deploy.ts", stack.name, stage]
    : ["alchemy", operation ?? "", "--config", entryFile(stack), "--stage", stage, "--no-input", ...args];
  const result = spawnSync("pnpm", ["exec", ...command], { cwd, stdio: "inherit", env: { ...process.env, ...(stack.component === "sfu" ? { CHALK_SFU_STACK: stack.name } : {}) } });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
