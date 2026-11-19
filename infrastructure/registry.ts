import { existsSync, readFileSync } from "node:fs";

const retiredHost = "Ported, deliberately not deployed: persistent Nightly host removed 2026-11-15 (PR #1432)";
const retiredSfu = "Ported, deliberately not deployed: shared staging SFU removed 2026-11-15 (PR #1453)";
// This flat union preserves the correlation between stack, variant, stage and
// ownership at both the type and CLI boundaries. No independent stage enum.
export const targets = [
  { name: "archive-cdn", component: "archive-cdn", stage: "nightly", owner: "alchemy", seeded: true, reason: "Cut over; existing resources retained" },
  { name: "recording-control-address", component: "recording-control-address", stage: "nightly", owner: "unmanaged", seeded: false, reason: retiredHost },
  { name: "transcription-dispatcher", component: "transcription-dispatcher", stage: "nightly", owner: "alchemy", seeded: true, reason: "Cut over; schedule expected DISABLED after coordinated retirement change" },
  { name: "transcription-dispatcher", component: "transcription-dispatcher", stage: "production", owner: "opentofu", seeded: false, reason: "Ported; production seed and cutover pending" },
  { name: "direct-sync", component: "direct-sync", stage: "nightly", owner: "opentofu", seeded: false, reason: retiredHost },
  { name: "sfu", component: "sfu", variant: "primary", stage: "nightly", owner: "opentofu", seeded: false, reason: retiredSfu },
  { name: "sfu", component: "sfu", variant: "primary", stage: "production", owner: "opentofu", seeded: false, reason: "Ported; live firewall drift blocks cutover" },
  { name: "sfu-standby", component: "sfu", variant: "standby", stage: "nightly", owner: "opentofu", seeded: false, reason: retiredSfu },
  { name: "sfu-standby", component: "sfu", variant: "standby", stage: "production", owner: "opentofu", seeded: false, reason: "Ported; dry-run is not cutover authorization" },
  { name: "recorder", component: "recorder", stage: "nightly", owner: "opentofu", seeded: false, reason: "Ported; retained root still owns policy resources" },
  { name: "recorder", component: "recorder", stage: "production", owner: "opentofu", seeded: false, reason: "Ported; reconcile CORS and pool firewall drift before cutover" },
  { name: "cloudflare-turn", component: "cloudflare-turn", stage: "nightly", owner: "unmanaged", seeded: false, reason: "Ported, deliberately not deployed; key creation/adoption not authorized" },
  { name: "cloudflare-turn", component: "cloudflare-turn", stage: "production", owner: "unmanaged", seeded: false, reason: "Ported, deliberately not deployed; key creation/adoption not authorized" },
] as const;
export type Target = typeof targets[number];
export type CutoverTarget = Extract<Target, { owner: "alchemy"; seeded: true }>;
export const stacks = targets.filter((target, index) => targets.findIndex((candidate) => candidate.name === target.name) === index);
export const entryFile = (stack: Target) => `${stack.component}/alchemy.run.ts`;
export const cutoverStages = () => targets.filter(isCutoverTarget).map((target) => ({ stack: target.name, stage: target.stage }));
function isCutoverTarget(target: Target): target is CutoverTarget {
  return target.owner === "alchemy" && target.seeded;
}
export function requireCutover(target: Target): CutoverTarget {
  if (!isCutoverTarget(target)) throw new Error(`Deploy refused: ${target.name}/${target.stage} is not cut over and seeded`);
  return target;
}
export function selectStack(name: string | undefined, stage: string | undefined): Target {
  const target = targets.find((target) => target.name === name && target.stage === stage);
  if (!target) throw new Error("Unknown stack/stage; run pnpm infra list");
  return target;
}
export function registryTable() {
  return ["| Stack | Stage | Owner | Seeded | Status | Entry |", "| --- | --- | --- | --- | --- | --- |", ...targets.map((target) => `| ${target.name} | ${target.stage} | ${target.owner} | ${target.seeded ? "yes" : "no"} | ${target.reason} | [${entryFile(target)}](${entryFile(target)}) |`)].join("\n");
}
export function checkRegistry() {
  for (const stack of stacks) {
    for (const file of [entryFile(stack), `${stack.component}/config.ts`, `${stack.component}/README.md`]) {
      if (!existsSync(new URL(file, import.meta.url))) throw new Error(`Registry file missing: ${file}`);
    }
  }
  const readme = readFileSync(new URL("README.md", import.meta.url), "utf8");
  if (!readme.includes(`<!-- stacks:start -->\n${registryTable()}\n<!-- stacks:end -->`)) throw new Error("Registry table is stale: pnpm infra table");
}
