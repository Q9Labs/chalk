// Generates every observability artifact from observability/registry: the typed kernel tables
// for TypeScript, Go and Elixir, the Go kernel copies, the Axiom field schema and budget, the
// coverage graph and the CLI's symptom and reason tables.
// Usage: node scripts/codegen/obs-registry.mjs [--write]
// Without --write it exits non-zero when any output differs from what is committed.
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { repositoryRoot } from "../lib/repository.mjs";
import { REGISTRY_DIR, emitJson, emitTypeScript, emitGo, emitElixir } from "./obs-registry/emit.mjs";
import { addField } from "./obs-registry/shape.mjs";
import { addArea, checkCrossReferences, axiomBudget } from "./obs-registry/events.mjs";

const GO_KERNEL_DIR = "observability/kernel/go";
const GO_TARGETS = ["apps/api/internal/obs", "features/media/sfu/internal/obs"];
const TS_REGISTRY = "sdks/typescript/client/src/obs/registry.ts";
const DISPATCHER_TS_REGISTRY = "apps/transcription-dispatcher/src/obs/registry.ts";
const EX_REGISTRY = "apps/sync/lib/chalk_sync/obs/generated/registry.ex";

export async function loadRegistry(root = repositoryRoot) {
  const read = async (path) => JSON.parse(await readFile(join(root, path), "utf8"));
  const areaFiles = (await readdir(join(root, REGISTRY_DIR, "areas"))).filter((file) => file.endsWith(".json")).sort();
  return {
    core: await read(`${REGISTRY_DIR}/core.json`),
    ids: await read(`${REGISTRY_DIR}/ids.json`),
    envelope: await read(`${REGISTRY_DIR}/envelope.json`),
    allowlist: await read(`${REGISTRY_DIR}/coverage-allowlist.json`),
    areas: await Promise.all(areaFiles.map(async (file) => ({ file, ...(await read(`${REGISTRY_DIR}/areas/${file}`)) }))),
  };
}

// Builds the normalized model and returns every problem found, so one run reports them all.
export function buildModel(source) {
  const { core, ids, envelope, allowlist, areas } = source;
  const kinds = core.kinds.map((entry) => entry.kind);
  const outcomes = core.outcomes.map((entry) => entry.outcome);
  const errors = [];
  const ctx = {
    core,
    kinds,
    datasets: core.datasets.map((entry) => entry.name),
    enumSources: {
      "core.modules": core.modules,
      "core.environments": core.environments,
      "core.platforms": core.platforms,
      "core.clock_states": core.clock_states.map((entry) => entry.state),
      "core.kinds": kinds,
      "core.outcomes": outcomes,
      "core.surface_states": core.surface_states,
    },
    idKinds: new Map(ids.kinds.map((entry) => [entry.kind, entry])),
    items: core.items.map((entry) => entry.item),
    sources: core.sources.map((entry) => entry.source),
    facts: new Map(),
    fail: (where, message) => errors.push(`${where}: ${message}`),
    fields: new Map(),
    reasons: new Map(core.reserved_reasons.map((entry) => [entry.code, { code: entry.code, outcome: entry.outcome, area: "core", test_only: false, doc: entry.doc }])),
    events: new Map(),
    machines: new Map(),
    symptoms: new Map(),
    prefixOwners: new Map(),
    recordFields: new Set(envelope.groups.find((group) => group.group === "record").fields.map((field) => field.name)),
  };
  const envelopeGroups = envelope.groups.map((group) => {
    for (const field of group.fields) addField(ctx, `envelope.json ${group.group}`, field, `envelope.${group.group}`);
    return { group: group.group, fields: group.fields.map((field) => field.name) };
  });
  const normalizedAreas = areas.map((area) => addArea(ctx, area));
  checkCrossReferences(ctx, allowlist);
  const axiom = axiomBudget(ctx);

  const sorted = (map) => [...map.values()].sort((a, b) => (a.name ?? a.code).localeCompare(b.name ?? b.code));
  const model = {
    kinds,
    outcomes,
    surface_states: core.surface_states,
    datasets: core.datasets.map(({ name, budget }) => ({ name, budget })),
    modules: core.modules,
    platforms: core.platforms,
    environments: core.environments,
    clock_states: ctx.enumSources["core.clock_states"],
    clock: { drift_ppm: core.clock.drift_ppm, jump_ms: core.clock.jump_ms },
    sensitivity_levels: core.sensitivity_levels,
    items: ctx.items,
    sources: core.sources.map(({ source, per_seat }) => ({ source, per_seat })),
    fault_components: { components: core.fault_components.components, standalone: core.fault_components.standalone },
    id_kinds: ids.kinds.map(({ kind, prefix, field, canonical, scope, companions, legacy_hash_field }) => ({ kind, prefix, field, canonical, scope: scope ?? null, companions: companions ?? [], legacy_hash_field: legacy_hash_field ?? null })),
    session_meanings: ids.session_meanings.map(({ meaning, kind, lookup }) => ({ meaning, kind, lookup })),
    diagnostic_code: { prefix: ids.diagnostic_code.prefix, length: ids.diagnostic_code.length, alphabet: ids.diagnostic_code.alphabet, source_kind: ids.diagnostic_code.source_kind },
    envelope: envelopeGroups,
    areas: normalizedAreas.sort((a, b) => a.area.localeCompare(b.area)),
    fields: [...ctx.fields.values()].sort((a, b) => a.name.localeCompare(b.name)),
    reasons: sorted(ctx.reasons),
    events: sorted(ctx.events),
    machines: sorted(ctx.machines),
    facts: sorted(ctx.facts),
    symptoms: sorted(ctx.symptoms),
    incomplete: allowlist.incomplete.map(({ code, slice }) => ({ code, slice })).sort((a, b) => a.code.localeCompare(b.code)),
  };
  const schemaVer = createHash("sha256").update(JSON.stringify(model)).digest("hex").slice(0, 12);
  return { errors, model: { schema_ver: schemaVer, ...model }, axiom };
}

// ---------- Emitters ----------

async function goKernelFiles(root) {
  const files = (await readdir(join(root, GO_KERNEL_DIR))).filter((file) => file.endsWith(".go")).sort();
  const out = {};
  for (const file of files) {
    const body = await readFile(join(root, GO_KERNEL_DIR, file), "utf8");
    const header = `// Code generated by scripts/codegen/obs-registry.mjs from ${GO_KERNEL_DIR}/${file}. DO NOT EDIT.\n\n`;
    for (const target of GO_TARGETS) out[`${target}/${file}`] = header + body;
  }
  return out;
}

export async function generate(root = repositoryRoot) {
  const { errors, model, axiom } = buildModel(await loadRegistry(root));
  if (errors.length > 0) return { errors, outputs: {} };
  const outputs = {};
  for (const [path, value] of Object.entries(emitJson(model, axiom))) outputs[path] = `${JSON.stringify(value, null, 2)}\n`;
  outputs[TS_REGISTRY] = emitTypeScript(model);
  outputs[DISPATCHER_TS_REGISTRY] = emitTypeScript(model);
  outputs[EX_REGISTRY] = emitElixir(model);
  const goRegistry = emitGo(model);
  for (const target of GO_TARGETS) outputs[`${target}/registry_gen.go`] = goRegistry;
  Object.assign(outputs, await goKernelFiles(root));
  return { errors, outputs };
}

async function writeFiles(root, files) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repositoryRoot, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} ${args[0]} failed:\n${result.stdout}${result.stderr}`);
}

// Formats in a scratch directory so the comparison sees exactly what --write would commit.
async function formatted(outputs) {
  const scratch = await mkdtemp(join(tmpdir(), "obs-registry-"));
  try {
    await writeFiles(scratch, outputs);
    const paths = Object.keys(outputs);
    const inScratch = (pattern) => paths.filter((path) => pattern.test(path)).map((path) => join(scratch, path));
    run("pnpm", ["exec", "oxfmt", "--config", join(repositoryRoot, ".oxfmtrc.json"), "--write", ...inScratch(/\.(ts|json)$/u)]);
    run("gofmt", ["-w", ...inScratch(/\.go$/u)]);
    return Object.fromEntries(await Promise.all(paths.map(async (path) => [path, await readFile(join(scratch, path), "utf8")])));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

async function main() {
  const write = process.argv.includes("--write");
  const { errors, outputs } = await generate();
  if (errors.length > 0) fail(`observability registry has ${errors.length} problem(s):\n${errors.map((error) => `  - ${error}`).join("\n")}`);
  const files = await formatted(outputs);
  const current = await Promise.all(Object.keys(files).map((path) => readFile(join(repositoryRoot, path), "utf8").catch(() => null)));
  const stale = Object.keys(files).filter((path, index) => current[index] !== files[path]);
  await (write ? writeStale(files, stale) : checkStale(stale));
}

function checkStale(stale) {
  if (stale.length > 0) fail(`observability registry outputs are stale: ${stale.join(", ")}\nRun pnpm run regen.`);
}

async function writeStale(files, stale) {
  await writeFiles(repositoryRoot, Object.fromEntries(stale.map((path) => [path, files[path]])));
  console.log(stale.length === 0 ? "observability registry outputs are current" : `wrote ${stale.join(", ")}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
