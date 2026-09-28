import { defineGate, lanes } from "@q9labsai/gates";
import { createGatePlan } from "./scripts/gates/chalk-gate-plan.mjs";

const taskIds = ["self-test", "language-ratchet", "hygiene", "secrets", "architecture", "format", "fallow", "semgrep", "boundaries", "osv", "services", "contracts", "image-size", "syncpack", "types", "tests", "build", "recorder", "publint", "attw"];
const alwaysIds = new Set(["self-test", "language-ratchet", "hygiene", "secrets"]);
const sharedTargetRoots = [
  "apps/api",
  "apps/sync",
  "apps/recording-renderer",
  "apps/transcription-dispatcher",
  "contract",
  "docs",
  "infrastructure",
  "packages",
  "scratchpad",
  "scripts",
  "sdks/typescript",
  "tools",
  "AGENTS.md",
  "CHANGELOG.md",
  "GLOSSARY.md",
  "README.md",
  "checklist.md",
  "design.md",
  "theory.md",
  "tracker-human.md",
];
const explicitFiles = process.env.GATE_FILES !== undefined || process.argv.some((argument) => argument === "--files" || argument.startsWith("--files="));

function chalkPlan(context: { allChangedFiles: readonly string[]; scope: string; classification: { fullRequired: boolean }; target: string | undefined; base?: string }) {
  const target = process.env.GATE_TARGET ?? context.target;
  if (process.env.GATE_TARGET && context.target && process.env.GATE_TARGET !== context.target) throw new Error("GATE_TARGET and --target must match");
  return createGatePlan([...context.allChangedFiles], {
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
      if (id === "secrets" && explicitFiles) env.push({ name: "GATE_EXPLICIT_FILES", value: context.allChangedFiles.join("\n") });
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
  targets: { web: ["apps/web", ...sharedTargetRoots], mobile: ["apps/mobile", ...sharedTargetRoots] },
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
