import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// A component may have several state identities (SFU primary and standby), but
// each identity has exactly one entrypoint and an explicit owner per stage.
export const stacks = [
  { name: "archive-cdn", component: "archive-cdn", stages: [{ name: "nightly", owner: "alchemy" }] },
  { name: "recording-control-address", component: "recording-control-address", stages: [{ name: "nightly", owner: "unmanaged" }] },
  { name: "transcription-dispatcher", component: "transcription-dispatcher", stages: [{ name: "nightly", owner: "alchemy" }, { name: "production", owner: "opentofu" }] },
  { name: "direct-sync", component: "direct-sync", stages: [{ name: "nightly", owner: "opentofu" }] },
  { name: "sfu", component: "sfu", stages: [{ name: "nightly", owner: "opentofu" }, { name: "production", owner: "opentofu" }] },
  { name: "sfu-standby", component: "sfu", stages: [{ name: "nightly", owner: "opentofu" }, { name: "production", owner: "opentofu" }] },
  { name: "recorder", component: "recorder", stages: [{ name: "nightly", owner: "opentofu" }, { name: "production", owner: "opentofu" }] },
  { name: "cloudflare-turn", component: "cloudflare-turn", stages: [{ name: "nightly", owner: "unmanaged" }, { name: "production", owner: "unmanaged" }] },
] as const;
export type Stack = typeof stacks[number];
export const entryFile = (stack: Stack) => `${stack.component}/alchemy.run.ts`;
export const cutoverStages = () => stacks.flatMap((stack) => stack.stages.filter((stage) => stage.owner === "alchemy").map((stage) => ({ stack: stack.name, stage: stage.name })));
export function selectStack(name: string | undefined, stageName: string | undefined) {
  const stack = stacks.find((stack) => stack.name === name);
  const stage = stack?.stages.find((stage) => stage.name === stageName);
  if (!stack || !stage) throw new Error("Unknown stack/stage; run pnpm infra list");
  return { stack, stage };
}
export function registryTable() {
  return ["| Stack | Stage | Owner | Entry |", "| --- | --- | --- | --- |", ...stacks.flatMap((stack) => stack.stages.map((stage) => `| ${stack.name} | ${stage.name} | ${stage.owner} | [${entryFile(stack)}](${entryFile(stack)}) |`))].join("\n");
}
export function checkRegistry() {
  for (const stack of stacks) {
    for (const file of [entryFile(stack), `${stack.component}/config.ts`, `${stack.component}/README.md`]) {
      if (!existsSync(new URL(file, import.meta.url))) throw new Error(`Registry file missing: ${file}`);
    }
  }
  const readme = readFileSync(fileURLToPath(new URL("README.md", import.meta.url)), "utf8");
  if (!readme.includes(`<!-- stacks:start -->\n${registryTable()}\n<!-- stacks:end -->`)) throw new Error("Registry table is stale: pnpm infra table");
}
