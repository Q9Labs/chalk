import { defineGate, lanes } from "@q9labsai/gates";
import { createGatePlan } from "./scripts/gates/chalk-gate-plan.mjs";

const taskIds = ["self-test", "language-ratchet", "hygiene", "secrets", "architecture", "format", "fallow", "semgrep", "boundaries", "osv", "services", "contracts", "image-size", "syncpack", "types", "tests", "build", "recorder", "publint", "attw"];

function chalkPlan(context: { changedFiles: readonly string[]; scope: string; classification: { fullRequired: boolean }; base?: string }) {
  return createGatePlan([...context.changedFiles], {
    full: context.scope === "full" || context.classification.fullRequired,
    scope: context.scope === "branch" ? "merge base to HEAD" : "staged",
    base: context.base ?? process.env.GATE_BASE_REF ?? "origin/master",
    target: process.env.GATE_TARGET,
    snapshot: context.scope === "staged" ? { mode: "index" } : context.scope === "branch" ? { mode: "ref", ref: "HEAD" } : { mode: "worktree" },
  });
}

const chalkLanes = taskIds.map((id) =>
  lanes.custom({
    id,
    title: `Chalk ${id}`,
    exclusive: true,
    triggers: (context) => chalkPlan(context).tasks.some((task) => task.id === id && task.selected),
    run: async (context) => {
      const task = chalkPlan(context).tasks.find((candidate) => candidate.id === id);
      if (!task?.command) return { status: "failed", findings: [{ file: "gate.config.ts", rule: id, message: "Chalk gate task has no command" }] };
      const [command, ...args] = task.command;
      const result = await context.exec(command, args, {
        cwd: context.repoRoot,
        env: Object.entries(task.env).map(([name, value]) => ({ name, value })),
      });
      return result.failed ? { status: "failed", findings: [{ file: "gate.config.ts", rule: id, message: [result.stdout, result.stderr].filter(Boolean).join("\n") || `${id} failed` }] } : { status: "passed" };
    },
  }),
);

export default defineGate({
  workspaceRoots: ["apps", "infrastructure", "packages", "sdks/typescript", "tools"],
  classifiers: {
    // q9gate 0.3 otherwise bypasses Chalk's always-on lanes for docs-only diffs.
    gateDefinition: ["*.md", "*.mdx", "*.txt", ".dependency-cruiser.cjs", ".fallowrc.json"],
    source: [".go", ".ex", ".exs"],
    dependency: ["go.mod", "go.sum", "mix.exs", "mix.lock"],
    infra: ["infrastructure/"],
    contract: ["contract/", "packages/diagnostics-contracts/"],
  },
  concurrency: 1,
  lanes: [...chalkLanes, lanes.custom({ id: "depcruise", title: "Dependency Cruiser", triggers: ["source", "contract"], exclusive: true, run: "node scripts/gates/depcruise.mjs" })],
});
