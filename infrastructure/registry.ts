import { existsSync, readFileSync } from "node:fs";
import { parseStage } from "./platform/stages.ts";

const retiredHost = "Retire: persistent Nightly host removed 2026-11-15 (PR #1432); proofs create and delete their own host";
const retiredSfu = "Retire: shared staging SFU removed 2026-11-15 (PR #1453); proofs use isolated run-owned SFU instances";
type RegisteredTarget = { readonly stackName: string; readonly directory: string; readonly reason: string } & (
  | { readonly stageKind: "retired"; readonly legacyStackName: string; readonly owner: "alchemy" }
  | { readonly stageKind: "retired"; readonly legacyStackName: string; readonly owner: "opentofu"; readonly root: string }
  | { readonly stageKind: "ephemeral"; readonly provisioner: "alchemy" }
  | ({ readonly stageKind: "production" } & ProductionOwnership)
);
// Retired records are cleanup inventory, never deployable stages.
const targets = [
  { stackName: "recorder-runtime-downloads", directory: "recorder-runtime-downloads", stageKind: "retired", legacyStackName: "archive-cdn", owner: "alchemy", reason: "Retire: Nightly proofs do not consume recorder runtime CDN downloads" },
  { stackName: "recorder-control-endpoint", directory: "recorder-control-endpoint", stageKind: "retired", legacyStackName: "recording-control-address", owner: "alchemy", reason: retiredHost },
  { stackName: "sync-direct-access", directory: "sync-direct-access", stageKind: "retired", legacyStackName: "direct-sync", owner: "opentofu", root: "managed-episode/direct-sync/opentofu", reason: retiredHost },
  { stackName: "sfu", directory: "sfu", stageKind: "retired", legacyStackName: "sfu", owner: "opentofu", root: "sfu", reason: retiredSfu },
  { stackName: "sfu-standby", directory: "sfu", stageKind: "retired", legacyStackName: "sfu-standby", owner: "opentofu", root: "sfu", reason: retiredSfu },
  { stackName: "transcription-dispatcher", directory: "transcription-dispatcher", stageKind: "retired", legacyStackName: "transcription-dispatcher", owner: "alchemy", reason: "Retire: no between-run control API or reconciliation schedule; per-run proof replaces the old release gate" },
  { stackName: "transcription-dispatcher", directory: "transcription-dispatcher", stageKind: "ephemeral", provisioner: "alchemy", reason: "Run-owned deploy/release/convergence/cleanup proof; no seed or always-on Nightly" },
  { stackName: "transcription-dispatcher", directory: "transcription-dispatcher", stageKind: "production", provisioner: "opentofu", seeded: false, reason: "Ported; production cutover waits for an ephemeral release proof" },
  { stackName: "sfu", directory: "sfu", stageKind: "production", provisioner: "opentofu", seeded: false, reason: "Primary variant: ported; live firewall drift blocks cutover" },
  { stackName: "sfu-standby", directory: "sfu", stageKind: "production", provisioner: "opentofu", seeded: false, reason: "Standby variant: ported; dry-run is not cutover authorization" },
  { stackName: "recorder", directory: "recorder", stageKind: "production", provisioner: "opentofu", seeded: false, reason: "Ported; reconcile CORS/pool firewall drift before cutover" },
  { stackName: "media-relay-access", directory: "media-relay-access", stageKind: "production", provisioner: "none", seeded: false, reason: "Ported, deliberately not deployed; TURN key creation/adoption not authorized" },
] as const satisfies readonly RegisteredTarget[];
export type Target = typeof targets[number];
export type RetiredTarget = Extract<Target, { stageKind: "retired" }>;
export const stacks = targets.filter((target, index) => targets.findIndex((candidate) => candidate.stackName === target.stackName) === index);
export const entryFile = (stack: Target) => `${stack.directory}/alchemy.run.ts`;
type ProductionOwnership = { readonly provisioner: "alchemy"; readonly seeded: true } | { readonly provisioner: "opentofu" | "none"; readonly seeded: false };
const isCutover = (target: ProductionOwnership): boolean => target.provisioner === "alchemy";
export const cutoverStages = () => targets.filter((target) => target.stageKind === "production" && isCutover(target)).map((target) => ({ stack: target.stackName, stage: "production" }));
export function selectStack(name: string | undefined, stageName: string | undefined) {
  const stage = parseStage(stageName);
  const target = targets.find((target) => target.stackName === name && target.stageKind === stage.kind);
  if (!target || target.stageKind === "retired") throw new Error("Unsupported stack/stage kind; run pnpm infra list");
  return { target, stage };
}
export function requireDeployable(target: Exclude<Target, RetiredTarget>) {
  if (target.stageKind === "ephemeral") return target;
  if (!isCutover(target)) throw new Error("Deploy refused: production is not cut over and seeded");
  return target;
}
export function retiredTarget(name: string | undefined): RetiredTarget {
  const target = targets.find((target): target is RetiredTarget => target.stackName === name && target.stageKind === "retired");
  if (!target) throw new Error("No retired Nightly state identity for this stack");
  return target;
}
export function registryTable() {
  return ["| Stack | Stage kind | Provisioner | Status | Entry |", "| --- | --- | --- | --- | --- |", ...targets.map((target) => `| ${target.stackName} | ${target.stageKind === "retired" ? "retired legacy Nightly (not deployable)" : target.stageKind === "ephemeral" ? "nightly-<run-id> (ephemeral)" : "production (persistent)"} | ${target.stageKind === "retired" ? "cleanup inventory" : target.provisioner} | ${target.reason} | [${entryFile(target)}](${entryFile(target)}) |`)].join("\n");
}
export function checkRegistry() {
  for (const stack of stacks) for (const file of [entryFile(stack), `${stack.directory}/config.ts`, `${stack.directory}/README.md`]) {
    if (!existsSync(new URL(file, import.meta.url))) throw new Error(`Registry file missing: ${file}`);
  }
  const readme = readFileSync(new URL("README.md", import.meta.url), "utf8");
  if (!readme.includes(`<!-- stacks:start -->\n${registryTable()}\n<!-- stacks:end -->`)) throw new Error("Registry table is stale: pnpm infra table");
}
