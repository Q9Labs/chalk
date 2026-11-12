import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { createGatePlan } from "./chalk-gate-plan.mjs";
import { readRegister } from "./register.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const RUNS = new Set(["commit", "local", "pull_request", "merge_queue", "cut", "promote", "push", "daily", "weekly", "manual"]);
// merge, release and commit block; alert opens an issue or pages someone; advisory is red on a pull request but is not a required context;
// action is work that is not a check (a build, a deploy, a cache warm).
const BLOCKS = new Set(["merge", "release", "commit", "alert", "advisory", "action"]);
const RECORDS = new Set(["caught", "noise", "never-failed", "unmeasured"]);
const FIELDS = ["id", "owner", "catches", "runs", "blocks", "minutes", "record", "sample", "reason", "builtin"];

function shapeProblems(entry) {
  const problems = [];
  const where = entry.id ?? JSON.stringify(entry).slice(0, 60);
  for (const key of Object.keys(entry)) if (!FIELDS.includes(key)) problems.push(`${where}: unknown field ${key}`);
  for (const key of ["id", "owner", "catches", "sample"]) {
    if (typeof entry[key] !== "string" || entry[key].trim() === "") problems.push(`${where}: ${key} must be a non-empty string`);
  }
  if (typeof entry.catches === "string" && (!entry.catches.endsWith(".") || entry.catches.includes("\n") || entry.catches.length > 220)) {
    problems.push(`${where}: catches is one sentence of at most 220 characters that ends with a full stop`);
  }
  if (!Array.isArray(entry.runs) || entry.runs.length === 0 || entry.runs.some((run) => !RUNS.has(run))) problems.push(`${where}: runs must list values from ${[...RUNS].join(", ")}`);
  if (!BLOCKS.has(entry.blocks)) problems.push(`${where}: blocks must be one of ${[...BLOCKS].join(", ")}; a check that blocks nothing is deleted`);
  if (entry.minutes !== null && !(typeof entry.minutes === "number" && entry.minutes >= 0)) problems.push(`${where}: minutes must be a number or null`);
  if (!RECORDS.has(entry.record)) problems.push(`${where}: record must be one of ${[...RECORDS].join(", ")}`);
  if (entry.blocks === "advisory" && (typeof entry.reason !== "string" || entry.reason.trim() === "")) problems.push(`${where}: an advisory check needs a reason it stays and why it does not block`);
  if (entry.blocks === "merge" && !entry.runs?.some((run) => ["pull_request", "merge_queue", "local"].includes(run))) problems.push(`${where}: blocks merge but never runs on a pull request or in the merge queue`);
  if (entry.blocks === "release" && !entry.runs?.some((run) => ["cut", "promote", "daily"].includes(run))) problems.push(`${where}: blocks release but never runs in a cut or Promote`);
  return problems;
}

function workflowJobIds() {
  const directory = path.join(root, ".github/workflows");
  return readdirSync(directory)
    .filter((file) => file.endsWith(".yml"))
    .sort()
    .flatMap((file) => Object.keys(yaml.load(readFileSync(path.join(directory, file), "utf8")).jobs).map((job) => `workflow:${file}#${job}`));
}

function hookIds() {
  const config = yaml.load(readFileSync(path.join(root, "lefthook.yml"), "utf8"));
  return Object.entries(config).flatMap(([hook, value]) => Object.keys(value?.commands ?? {}).map((command) => `hook:${hook}/${command}`));
}

function budgetGroups() {
  const { budgets } = JSON.parse(readFileSync(path.join(root, "perf/budgets.json"), "utf8"));
  const groups = new Map();
  for (const [id, budget] of Object.entries(budgets)) {
    const group = `scorecard:${id.split(".").slice(0, 2).join(".")}`;
    groups.set(group, (groups.get(group) ?? true) && budget.gate === true);
  }
  return groups;
}

/** findProblems returns every way the register and the things it covers disagree. */
export function findProblems(entries = readRegister()) {
  const problems = entries.flatMap(shapeProblems);
  const ids = entries.map((entry) => entry.id);
  for (const id of ids) if (ids.indexOf(id) !== ids.lastIndexOf(id)) problems.push(`${id}: listed twice`);

  const cover = (kind, expected) => {
    for (const id of expected) if (!ids.includes(id)) problems.push(`${id}: no register entry. Add one to scripts/gates/checks.json, or delete the ${kind}.`);
    for (const id of ids.filter((candidate) => candidate.startsWith(`${kind}:`))) if (!expected.includes(id)) problems.push(`${id}: no ${kind} by this name exists. Remove the entry.`);
  };

  cover("workflow", workflowJobIds());
  cover("hook", hookIds());
  const groups = budgetGroups();
  cover("scorecard", [...groups.keys()]);
  for (const [id, gated] of groups) if (!gated) problems.push(`${id}: holds a budget with gate false. A budget gates or is deleted.`);

  const planned = createGatePlan(["README.md"], { full: true }).tasks.map((task) => task.id);
  const gateEntries = entries.filter((entry) => entry.id.startsWith("gate:"));
  const config = readFileSync(path.join(root, "gate.config.ts"), "utf8");
  const builtins = [
    ...[...config.matchAll(/lanes\.(?!custom\b)([A-Za-z]+)\(/g)].map((match) => match[1].replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)),
    ...[...config.matchAll(/^\s*id: "([a-z-]+)"/gm)].map((match) => match[1]),
  ];
  for (const id of [...planned, ...builtins]) if (!ids.includes(`gate:${id}`)) problems.push(`gate:${id}: no register entry.`);
  for (const entry of gateEntries) {
    const id = entry.id.slice("gate:".length);
    if (entry.builtin) {
      if (!config.includes(`"${id}"`) && !config.includes(`lanes.${id === "design-tokens" ? "designTokens" : id}(`)) problems.push(`${entry.id}: gate.config.ts defines no lane by this name. Remove the entry.`);
    } else if (!planned.includes(id)) {
      problems.push(`${entry.id}: the planner has no task by this name. Remove the entry.`);
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = findProblems();
  if (problems.length > 0) {
    console.error(`${problems.length} problem(s) in the checks register:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`Checks register is complete: ${readRegister().length} entries.`);
}
