import { defineGate, lanes } from "@q9labsai/gates";
import { createGatePlan, emptyScopeResult, gatePlanOptions, laneEnvironment, laneResult } from "./scripts/gates/chalk-gate-plan.mjs";

const taskIds = ["self-test", "language-ratchet", "hygiene", "secrets", "generated", "architecture", "format", "fallow", "semgrep", "boundaries", "osv", "services", "contracts", "image-size", "syncpack", "types", "tests", "build", "recorder", "publint", "attw"];
// Format is always on so documentation-only changes are still checked.
const alwaysIds = new Set(["self-test", "language-ratchet", "hygiene", "secrets", "generated", "format"]);
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

type GateContext = { allChangedFiles: readonly string[]; scope: string; classification: { fullRequired: boolean }; target: string | undefined; base?: string };

function chalkPlan(context: GateContext) {
  return createGatePlan([...context.allChangedFiles], gatePlanOptions(context));
}

const chalkLanes = taskIds.map((id) =>
  lanes.custom({
    id,
    title: `Chalk ${id}`,
    exclusive: true,
    triggers: alwaysIds.has(id) ? "always" : (context) => chalkPlan(context).tasks.some((task) => task.id === id && task.selected),
    run: async (context) => {
      const task = chalkPlan(context).tasks.find((candidate) => candidate.id === id);
      if (!task?.command) return { status: "skipped" };
      const [command, ...args] = task.command;
      const env = laneEnvironment(id, task.env, context.allChangedFiles, explicitFiles);
      return laneResult(id, await context.exec(command, args, { cwd: context.repoRoot, env }));
    },
  }),
);

// q9gate skips every lane when nothing is in scope and still exits 0. That is not a pass.
const emptyScopeLane = lanes.custom({
  id: "scope",
  title: "Chalk non-empty scope",
  exclusive: true,
  triggers: (context) => context.allChangedFiles.length === 0,
  run: async (context) => emptyScopeResult(context),
});

export default defineGate({
  workspaceRoots: ["apps", "infrastructure", "packages", "sdks/typescript", "tools"],
  targets: { web: ["apps/web", ...sharedTargetRoots], mobile: ["apps/mobile", ...sharedTargetRoots] },
  classifiers: {
    docs: ["*.md", "*.mdx", "*.txt"],
    gateDefinition: [".dependency-cruiser.cjs", ".fallowrc.json"],
    source: [".go", ".ex", ".exs", ".sql"],
    dependency: ["go.mod", "go.sum", "mix.exs", "mix.lock"],
    infra: ["infrastructure/"],
    contract: ["contract/", "packages/diagnostics-contracts/"],
  },
  concurrency: 1,
  lanes: [emptyScopeLane, ...chalkLanes, lanes.depcruise({ config: ".dependency-cruiser.cjs", source: "." })],
});
