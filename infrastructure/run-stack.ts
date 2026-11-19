import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkRegistry, cutoverStages, entryFile, registryTable, requireDeployable, retiredTarget, selectStack } from "./registry.ts";

const [operation, name, stageName, ...args] = process.argv.slice(2);
const cwd = fileURLToPath(new URL(".", import.meta.url));
let command: string[] | undefined;
if (operation === "list") process.stdout.write(`${registryTable()}\n`);
else if (operation === "cutovers") process.stdout.write(`${JSON.stringify(cutoverStages())}\n`);
else if (operation === "check") checkRegistry();
else if (operation === "table") {
  const file = new URL("README.md", import.meta.url);
  writeFileSync(file, readFileSync(file, "utf8").replace(/<!-- stacks:start -->[\s\S]*?<!-- stacks:end -->/, `<!-- stacks:start -->\n${registryTable()}\n<!-- stacks:end -->`));
} else if (operation === "retire") {
  retiredTarget(name);
  if ((stageName !== undefined && stageName !== "--apply" && stageName !== "--settle") || args.length) throw new Error("Usage: pnpm infra retire <stack> [--apply|--settle]");
  command = ["tsx", "migration/retire-nightly.ts", name ?? "", ...(stageName ? [stageName] : [])];
} else {
  const { target, stage } = selectStack(name, stageName);
  if (!["plan", "deploy", "destroy", "drift", "seed", "prove"].includes(operation ?? "")) throw new Error("Usage: pnpm infra <plan|deploy|destroy|drift|seed|prove> <stack> <stage>");
  if (operation === "deploy") requireDeployable(target);
  if ((operation === "destroy" || operation === "prove") && stage.kind !== "ephemeral") throw new Error("Only run-owned ephemeral stages can be destroyed or proved");
  if (operation !== "seed" && args.length) throw new Error("Operations accept no overriding flags; configure private inputs through CHALK_INFRA_INPUTS");
  if (operation === "seed" && (stage.kind !== "production" || !args[0] || args[0].startsWith("-") || args.length > 2 || (args[1] !== undefined && args[1] !== "--dry-run"))) throw new Error("Seed requires production, a private state file and optional --dry-run");
  command =
    operation === "seed"
      ? ["tsx", "migration/seed.ts", target.stackName, stage.name, ...args]
      : operation === "deploy"
        ? ["tsx", "releases/deploy.ts", target.stackName, stage.name]
        : operation === "destroy"
          ? ["tsx", "releases/destroy-stage.ts", target.stackName, stage.name]
          : operation === "prove"
            ? ["tsx", "releases/prove-dispatcher.ts", stage.name]
            : operation === "plan" && target.stackName === "transcription-dispatcher"
              ? ["tsx", "releases/driver.ts", "plan", stage.name]
              : ["alchemy", operation ?? "", "--config", entryFile(target), "--stage", stage.name, "--no-input"];
}
if (command) {
  const result = spawnSync("pnpm", ["exec", ...command], { cwd, stdio: "inherit", env: { ...process.env, ...(name === "sfu" || name === "sfu-standby" ? { CHALK_SFU_STACK: name } : {}) } });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
