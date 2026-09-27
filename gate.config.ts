import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";

import { defineGate, lanes } from "@q9labsai/gates";
import { createGatePlan } from "./scripts/gates/chalk-gate-plan.mjs";

const taskIds = ["self-test", "language-ratchet", "hygiene", "secrets", "architecture", "format", "fallow", "semgrep", "boundaries", "osv", "services", "contracts", "image-size", "syncpack", "types", "tests", "build", "recorder", "publint", "attw"];
const alwaysIds = new Set(["self-test", "language-ratchet", "hygiene", "secrets"]);

function optionValues(flag: string) {
  const args = process.argv.slice(2);
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === flag) {
      const value = args[index + 1];
      if (value) values.push(value);
      index += 1;
    } else if (argument?.startsWith(`${flag}=`)) values.push(argument.slice(flag.length + 1));
  }
  return values;
}

// Keep the whole diff visible: Chalk targets reject incompatible workspaces instead of silently dropping their files.
const repositoryRoot = new URL(".", import.meta.url);
const previousRoots = execFileSync("git", ["ls-tree", "--name-only", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).split("\n");
const cliFiles = optionValues("--files");
const explicitPaths = [...cliFiles, ...(process.env.GATE_FILES ?? "").split(/[\n,]/)];
const base = optionValues("--base")[0];
const branchPaths = base ? execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { cwd: repositoryRoot, encoding: "utf8" }).split("\n") : [];
const requestedRoots = [...explicitPaths, ...branchPaths].map((file) => file.trim().replaceAll("\\", "/").split("/")[0]);
const targetScope = [...new Set([...readdirSync(repositoryRoot), ...previousRoots, ...requestedRoots])].filter((name) => name.length > 0);
const explicitFiles = process.env.GATE_FILES !== undefined || cliFiles.length > 0;

function chalkPlan(context: { changedFiles: readonly string[]; scope: string; classification: { fullRequired: boolean }; workspaceRoots?: readonly string[]; base?: string }) {
  const nativeTarget = context.workspaceRoots?.[0] === "apps/web" ? "web" : context.workspaceRoots?.[0] === "apps/mobile" ? "mobile" : undefined;
  const target = process.env.GATE_TARGET ?? nativeTarget;
  if (process.env.GATE_TARGET && nativeTarget && process.env.GATE_TARGET !== nativeTarget) throw new Error("GATE_TARGET and --target must match");
  return createGatePlan([...context.changedFiles], {
    full: context.scope === "full" || context.classification.fullRequired,
    scope: context.scope === "branch" ? "merge base to HEAD" : "staged",
    base: context.base ?? process.env.GATE_BASE_REF ?? "origin/master",
    target,
    snapshot: context.scope === "staged" ? { mode: "index" } : context.scope === "branch" ? { mode: "ref", ref: "HEAD" } : { mode: "worktree" },
  });
}

const chalkLanes = taskIds.map((id) =>
  lanes.custom({
    id,
    title: `Chalk ${id}`,
    exclusive: true,
    triggers: alwaysIds.has(id) ? "always" : (context) => chalkPlan(context).tasks.some((task) => task.id === id && task.selected),
    run: async (context) => {
      const task = chalkPlan(context).tasks.find((candidate) => candidate.id === id);
      if (!task?.command) return { status: "failed", findings: [{ file: "gate.config.ts", rule: id, message: "Chalk gate task has no command" }] };
      const [command, ...args] = task.command;
      const env = Object.entries(task.env).map(([name, value]) => ({ name, value }));
      if (id === "secrets" && explicitFiles) env.push({ name: "GATE_EXPLICIT_FILES", value: context.changedFiles.join("\n") });
      const result = await context.exec(command, args, {
        cwd: context.repoRoot,
        env,
      });
      return result.failed ? { status: "failed", findings: [{ file: "gate.config.ts", rule: id, message: [result.stdout, result.stderr].filter(Boolean).join("\n") || `${id} failed` }] } : { status: "passed" };
    },
  }),
);

export default defineGate({
  workspaceRoots: ["apps", "infrastructure", "packages", "sdks/typescript", "tools"],
  targets: { web: ["apps/web", ...targetScope], mobile: ["apps/mobile", ...targetScope] },
  classifiers: {
    docs: ["*.md", "*.mdx", "*.txt"],
    gateDefinition: [".dependency-cruiser.cjs", ".fallowrc.json"],
    source: [".go", ".ex", ".exs"],
    dependency: ["go.mod", "go.sum", "mix.exs", "mix.lock"],
    infra: ["infrastructure/"],
    contract: ["contract/", "packages/diagnostics-contracts/"],
  },
  concurrency: 1,
  lanes: [...chalkLanes, lanes.depcruise({ config: ".dependency-cruiser.cjs", source: "." })],
});
