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

const REGISTRY_DIR = "observability/registry";
const GENERATED_DIR = "observability/generated";
const GO_KERNEL_DIR = "observability/kernel/go";
const GO_TARGETS = ["apps/api/internal/obs", "features/media/sfu/internal/obs"];
const TS_REGISTRY = "sdks/typescript/client/src/obs/registry.ts";
const EX_REGISTRY = "apps/sync/lib/chalk_sync/obs/registry.ex";

const FIELD_TYPES = new Set(["string", "int", "number", "bool", "enum", "id", "map", "ranges"]);
const FACT_KINDS = new Set(["once", "state", "aggregate", "event"]);
const FACT_PERS = new Set(["seat", "item", "any"]);
const SIDES = new Set(["client", "server", "any"]);
const BANNED_UNIT_SUFFIXES = ["_s", "_sec", "_secs", "_seconds", "_millis", "_us", "_kb", "_mb", "_kbps", "_mbps", "_percent"];
const NAME = /^[a-z][a-z0-9_]*$/;
const DOTTED = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const AXIOM_TYPES = { string: "string", int: "integer", number: "float", bool: "boolean", enum: "string", id: "string", map: "map", ranges: "array" };

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

// Each check is [passes(subject, scope), message(subject, scope)]. A validator is a list of checks, and it reports
// every check that does not pass; a message may be a list when one check finds several problems.
const problemsOf = (checks, subject, scope) => checks.filter(([passes]) => !passes(subject, scope)).flatMap(([, message]) => message(subject, scope));
const report = (fail, where, problems) => {
  for (const problem of problems) fail(where, problem);
};
const present = (key, value) => (value ? { [key]: value } : {});
const isNonEmptyList = (value) => Array.isArray(value) && value.length > 0;
const allNames = (values) => isNonEmptyList(values) && values.every((value) => NAME.test(value));
const hasDoc = (entry) => typeof entry.doc === "string" && entry.doc.length > 0;
const isDotted = (value) => DOTTED.test(value ?? "");
const SYMPTOM_CODE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const enumValuesOf = (field, enumSources) => (field.values_from ? enumSources[field.values_from] : field.values);
const knownSensitivity = (field, core) => field.sensitivity === null || core.sensitivity_levels.includes(field.sensitivity);

const FIELD_CHECKS = [
  [(field) => !BANNED_UNIT_SUFFIXES.some((suffix) => field.name.endsWith(suffix)), (field) => `field ${field.name} uses a banned unit suffix; use _ms, _bytes, _bps or _pct`],
  [(field) => FIELD_TYPES.has(field.type), (field) => `field ${field.name} has unknown type ${JSON.stringify(field.type)}`],
  [(field) => "sensitivity" in field, (field) => `field ${field.name} needs a sensitivity slot (null until the privacy pass)`],
  [(field, { core }) => !("sensitivity" in field) || knownSensitivity(field, core), (field) => `field ${field.name} has unknown sensitivity ${JSON.stringify(field.sensitivity)}`],
  [(field, { enumSources }) => field.type !== "enum" || isNonEmptyList(enumValuesOf(field, enumSources)), (field) => `enum field ${field.name} needs values or a known values_from`],
  [(field) => field.type === "enum" || !(field.values || field.values_from), (field) => `field ${field.name} is not an enum but declares values`],
  [(field, { idKinds }) => field.type !== "id" || idKinds.has(field.id_kind), (field) => `id field ${field.name} has unknown id_kind ${JSON.stringify(field.id_kind)}`],
  [hasDoc, (field) => `field ${field.name} needs a doc`],
];

function fieldNameProblem({ fields }, field) {
  if (!NAME.test(field.name ?? "")) return `field name ${JSON.stringify(field.name)} must be snake_case`;
  if (fields.has(field.name)) return `field ${field.name} is already declared by ${fields.get(field.name).owner}`;
  return undefined;
}

function addField(ctx, where, field, owner) {
  const nameProblem = fieldNameProblem(ctx, field);
  if (nameProblem) return ctx.fail(where, nameProblem);
  report(ctx.fail, where, problemsOf(FIELD_CHECKS, field, ctx));
  const values = field.type === "enum" ? enumValuesOf(field, ctx.enumSources) : undefined;
  ctx.fields.set(field.name, {
    name: field.name,
    type: field.type,
    ...present("values", values),
    ...present("id_kind", field.id_kind),
    ...present("legacy_names", field.legacy_names),
    required: field.required === true,
    sensitivity: field.sensitivity ?? null,
    owner,
    doc: field.doc,
  });
}

const AREA_CHECKS = [
  [(area) => `${area.area}.json` === area.file, (area) => `area ${JSON.stringify(area.area)} must live in areas/${area.area}.json`],
  [(area) => Number.isInteger(area.slice), () => "slice must be the plan's slice number (0 for the foundation)"],
];

function claimPrefix({ prefixOwners, fail }, where, owner, prefix) {
  if (!NAME.test(prefix)) fail(where, `prefix ${JSON.stringify(prefix)} must be snake_case`);
  if (prefixOwners.has(prefix)) fail(where, `prefix ${prefix} is already owned by ${prefixOwners.get(prefix)}`);
  prefixOwners.set(prefix, owner);
}

const AREA_PARTS = [
  ["fields", (scope, field) => addField(scope, scope.where, field, `areas/${scope.area.area}`)],
  ["reasons", addReason],
  ["machines", addMachine],
  ["events", addEvent],
  ["facts", addFact],
  ["symptoms", addSymptom],
];

function addParts(scope, area) {
  for (const [key, add] of AREA_PARTS) for (const entry of area[key] ?? []) add(scope, entry);
}

function addArea(ctx, area) {
  const normalized = { area: area.area, slice: area.slice, title: area.title ?? "", prefixes: area.prefixes ?? [], test_only: area.test_only === true };
  const where = `areas/${area.file}`;
  report(ctx.fail, where, problemsOf(AREA_CHECKS, area));
  for (const prefix of normalized.prefixes) claimPrefix(ctx, where, area.area, prefix);
  const owns = (code) => normalized.prefixes.some((prefix) => code.startsWith(`${prefix}.`));
  addParts({ ...ctx, where, area: normalized, testOnly: normalized.test_only, owns }, area);
  return normalized;
}

const REASON_CHECKS = [
  [(reason) => isDotted(reason.code), (reason) => `reason ${JSON.stringify(reason.code)} must be dotted snake_case`],
  [(reason, { owns }) => !isDotted(reason.code) || owns(reason.code), (reason, { area }) => `reason ${reason.code} must start with one of this area's prefixes (${area.prefixes.join(", ")})`],
  [(reason, { reasons }) => !reasons.has(reason.code), (reason) => `reason ${reason.code} is declared twice`],
  [(reason) => reason.outcome === "expected" || reason.outcome === "error", (reason) => `reason ${reason.code} outcome must be expected or error`],
];

function addReason(scope, reason) {
  report(scope.fail, scope.where, problemsOf(REASON_CHECKS, reason, scope));
  scope.reasons.set(reason.code, { code: reason.code, outcome: reason.outcome, area: scope.area.area, test_only: scope.testOnly, doc: reason.doc ?? "" });
}

const edgeKey = ([from, to]) => `${from}>${to}`;
const EDGE_CHECKS = [
  [(edge, { states }) => edge.length === 2 && edge.every((state) => states.includes(state)), (edge) => `edge ${JSON.stringify(edge)} must join two declared states`],
  [([from, to]) => from !== to, ([from, to]) => `edge ${from} -> ${to} is a self-loop; the owner emits only real changes`],
  [(edge, { seen }) => !seen.has(edgeKey(edge)), ([from, to]) => `edge ${from} -> ${to} is declared twice`],
];

function edgeProblems(states, edges) {
  const seen = new Set();
  return edges.flatMap((edge) => {
    const problems = problemsOf(EDGE_CHECKS, edge, { states, seen });
    seen.add(edgeKey(edge));
    return problems;
  });
}

const uniqueNames = (values) => new Set(values).size === values.length && values.every((value) => NAME.test(value));
const MACHINE_CHECKS = [
  [(machine) => isDotted(machine.name), () => "machine name must be dotted snake_case"],
  [(machine, { machines }) => !machines.has(machine.name), () => "machine is declared twice"],
  [(machine) => machine.states.length >= 2 && uniqueNames(machine.states), () => "states must be at least two unique snake_case names"],
  [(machine) => machine.states.includes(machine.initial), (machine) => `initial state ${JSON.stringify(machine.initial)} is not a state`],
  [(machine) => allNames(machine.triggers), () => "triggers must be a non-empty list of snake_case names"],
];

function addMachine(scope, declared) {
  const machine = { states: [], edges: [], triggers: [], doc: "", ...declared };
  const problems = [...problemsOf(MACHINE_CHECKS, machine, scope), ...edgeProblems(machine.states, machine.edges)];
  report(scope.fail, `${scope.where} machine ${machine.name}`, problems);
  const { name, states, initial, edges, triggers, doc } = machine;
  scope.machines.set(name, { name, area: scope.area.area, test_only: scope.testOnly, states, initial, edges, triggers, doc });
}

const validLegacy = (legacy) => typeof legacy.match === "object" && Object.values(legacy.match).every((value) => typeof value === "string");
const unknownModules = (event, core) => event.modules.filter((module) => !core.modules.includes(module));
const EVENT_CHECKS = [
  [(event) => isDotted(event.name), () => "event name must be dotted snake_case"],
  [(event, { events }) => !events.has(event.name), (event, { events }) => `event is already declared by areas/${events.get(event.name).area}.json`],
  [(event, { kinds }) => kinds.includes(event.kind) && event.kind !== "transition", (event, { kinds }) => `kind must be one of ${kinds.filter((kind) => kind !== "transition").join(", ")}; a transition is declared as a machine`],
  [(event, { datasets }) => datasets.includes(event.dataset), (event, { datasets }) => `dataset must be one of ${datasets.join(", ")}`],
  [(event) => SIDES.has(event.side), () => "side must be client, server or any"],
  [(event, { core }) => unknownModules(event, core).length === 0, (event, { core }) => unknownModules(event, core).map((module) => `unknown module ${module}`)],
  [(event) => event.kind !== "decision" || allNames(event.decisions), () => "a decision event needs a non-empty decisions list"],
  [(event) => event.kind === "decision" || !event.decisions, () => "only a decision event declares decisions"],
  [(event) => event.emit_sites.every((site) => typeof site.path === "string" && typeof site.literal === "string"), () => "each emit site needs a path and a literal"],
  [(event) => !event.legacy || validLegacy(event.legacy), () => "legacy.match must map field names to strings"],
];

const valuesFit = (values, field) => !values || (field.type === "enum" && values.every((value) => field.values?.includes(value)));

function eventField({ fields, recordFields, fail }, at, name, rule) {
  const field = fields.get(name);
  if (!field) {
    fail(at, `field ${name} is not declared in envelope.json or an area's fields`);
    return undefined;
  }
  if (recordFields.has(name)) fail(at, `field ${name} is stamped by the kernel and cannot be declared on an event`);
  if (!valuesFit(rule.values, field)) fail(at, `values for ${name} must be a subset of the field's enum values`);
  return { required: rule.required === true, ...present("values", rule.values) };
}

function eventFieldsOf(scope, at, declared) {
  const entries = Object.entries(declared).map(([name, rule]) => [name, eventField(scope, at, name, rule)]);
  return Object.fromEntries(entries.filter(([, entry]) => entry));
}

function addEvent(scope, declared) {
  const event = { modules: [], fields: {}, emit_sites: [], doc: "", ...declared };
  const at = `${scope.where} event ${event.name}`;
  report(scope.fail, at, problemsOf(EVENT_CHECKS, event, scope));
  scope.events.set(event.name, {
    name: event.name,
    kind: event.kind,
    dataset: event.dataset,
    side: event.side,
    modules: event.modules,
    area: scope.area.area,
    test_only: scope.testOnly,
    ...present("decisions", event.decisions),
    fields: eventFieldsOf(scope, at, event.fields),
    emit_sites: event.emit_sites,
    ...present("legacy", event.legacy),
    doc: event.doc,
  });
}

// A fact is what a witness claims (scripts/diagnose-call/proof/facts.mjs explains the kinds). Each of its events says which
// source delivers it, which field carries the claim, and which claims are failures some finding must explain.
const FACT_CHECKS = [
  [(fact) => isDotted(fact.name), () => "fact name must be dotted snake_case"],
  [(fact, { owns }) => !isDotted(fact.name) || owns(fact.name), (fact, { area }) => `fact ${fact.name} must start with one of this area's prefixes (${area.prefixes.join(", ")})`],
  [(fact, { facts }) => !facts.has(fact.name), (fact, { facts }) => `fact ${fact.name} is already declared by areas/${facts.get(fact.name)?.area}.json`],
  [(fact) => FACT_KINDS.has(fact.kind), (fact) => `fact ${fact.name} kind must be one of ${[...FACT_KINDS].join(", ")}`],
  [(fact) => FACT_PERS.has(fact.per), (fact) => `fact ${fact.name} per must be one of ${[...FACT_PERS].join(", ")}`],
  [hasDoc, (fact) => `fact ${fact.name} needs a doc`],
];
const FACT_EVENT_CHECKS = [
  [(entry, { sources }) => sources.includes(entry.source), (entry, { sources }) => `event ${entry.event} source must be one of ${sources.join(", ")}`],
  [(entry) => NAME.test(entry.claim ?? ""), (entry) => `event ${entry.event} needs the claim field's name`],
  [(entry) => Array.isArray(entry.fields) && entry.fields.includes(entry.claim), (entry) => `event ${entry.event} fields must list the fields a fixture row carries, including the claim`],
  [(entry) => entry.failure_claims === undefined || allNames(entry.failure_claims), (entry) => `event ${entry.event} failure_claims must be snake_case claims`],
];

function addFact(scope, declared) {
  const fact = { events: [], ...declared };
  const where = `${scope.where} fact ${fact.name}`;
  report(scope.fail, where, [...problemsOf(FACT_CHECKS, fact, scope), ...fact.events.flatMap((entry) => problemsOf(FACT_EVENT_CHECKS, entry, scope))]);
  const events = fact.events.map(({ event, source, claim, failure_claims, fields }) => ({ event, source, claim, failure_claims: failure_claims ?? [], fields: fields ?? [] }));
  scope.facts.set(fact.name, { name: fact.name, area: scope.area.area, kind: fact.kind, per: fact.per, events, doc: fact.doc });
}

const SYMPTOM_CHECKS = [
  [(symptom) => SYMPTOM_CODE.test(symptom.code ?? ""), () => "symptom code must be <prefix>.<snake_case>"],
  [(symptom, { owns }) => !SYMPTOM_CODE.test(symptom.code ?? "") || owns(symptom.code), (symptom, { area }) => `symptom code must start with one of this area's prefixes (${area.prefixes.join(", ")})`],
  [(symptom, { symptoms }) => !symptoms.has(symptom.code), () => "symptom is declared twice"],
  [(symptom, { items }) => items.includes(symptom.item), (symptom, { items }) => `item must be one of ${items.join(", ")}, not ${JSON.stringify(symptom.item)}`],
  [(symptom) => symptom.per === "item" || symptom.per === "seat", () => "per must be item or seat"],
  [(symptom) => symptom.per !== "seat" || symptom.item === "episode", () => "a per-seat symptom belongs to an Episode"],
  [hasDoc, () => "symptom needs a doc"],
];

const WITNESS_CHECKS = [
  [(witness, { seen }) => isDotted(witness.fact) && !seen.has(witness.fact), (witness) => `witness fact ${JSON.stringify(witness.fact)} must be a dotted fact name, once per symptom`],
  [(witness, { sources }) => isNonEmptyList(witness.from) && witness.from.every((source) => sources.includes(source)), (witness, { sources }) => `witness ${witness.fact} from must list sources out of ${sources.join(", ")}`],
  [(witness) => typeof witness.required === "boolean", (witness) => `witness ${witness.fact} must say whether it is required`],
  [(witness) => witness.independent === undefined || (Number.isInteger(witness.independent) && witness.independent >= 1), (witness) => `witness ${witness.fact} independent must be a positive integer`],
  [(witness) => typeof witness.query === "string" && witness.query.length > 0, (witness) => `witness ${witness.fact} needs the proof query a reader reruns`],
  [hasDoc, (witness) => `witness ${witness.fact} needs a doc`],
];

function witnessProblems(witnesses, sources) {
  const seen = new Set();
  return witnesses.flatMap((witness) => {
    const problems = problemsOf(WITNESS_CHECKS, witness, { seen, sources });
    seen.add(witness.fact);
    return problems;
  });
}

const witnessRecord = ({ fact, from, required, independent, query, doc }) => ({ fact, from, required, independent: independent ?? 1, query, doc });

function addSymptom(scope, declared) {
  const symptom = { user_words: [], witnesses: [], fault_scenario: null, ...declared };
  const { code } = symptom;
  report(scope.fail, `${scope.where} symptom ${code}`, [...problemsOf(SYMPTOM_CHECKS, symptom, scope), ...witnessProblems(symptom.witnesses, scope.sources)]);
  scope.symptoms.set(code, {
    code,
    area: scope.area.area,
    slice: scope.area.slice,
    item: symptom.item,
    per: symptom.per,
    doc: symptom.doc,
    user_words: symptom.user_words,
    witnesses: symptom.witnesses.map(witnessRecord),
    rule: `observability/rules/${code}.mjs`,
    fixtures: { positive: `observability/fixtures/${code}/positive.json`, healthy: `observability/fixtures/${code}/healthy.json` },
    fault_scenario: symptom.fault_scenario,
  });
}

const isEnvelopeField = (fields, name) => fields.get(name)?.owner.startsWith("envelope.") === true;

function factEventProblems({ events, fields }, fact) {
  return fact.events.flatMap((entry) => {
    const event = events.get(entry.event);
    if (!event) return [`fact ${fact.name} names unknown event ${entry.event}`];
    const stray = entry.fields.filter((name) => !(name in event.fields) && !isEnvelopeField(fields, name));
    const failures = entry.failure_claims.filter((claim) => !(event.fields[entry.claim]?.values ?? fields.get(entry.claim)?.values ?? [claim]).includes(claim));
    return [...stray.map((name) => `fact ${fact.name} field ${name} is neither on ${event.name} nor in the envelope`), ...failures.map((claim) => `fact ${fact.name} failure claim ${claim} is not a value of ${event.name}.${entry.claim}`)];
  });
}

// Witnesses, name clashes and the allow-list can only be checked once every area is known.
function checkCrossReferences(ctx, allowlist) {
  for (const fact of ctx.facts.values()) report(ctx.fail, `fact ${fact.name}`, factEventProblems(ctx, fact));
  for (const symptom of ctx.symptoms.values()) {
    const unknown = symptom.witnesses.filter((witness) => !ctx.facts.has(witness.fact));
    report(
      ctx.fail,
      `symptom ${symptom.code}`,
      unknown.map((witness) => `witness names unknown fact ${witness.fact}; declare it under an area's facts`),
    );
  }
  const fault = ctx.core.fault_components;
  for (const name of [...fault.components, ...fault.standalone].filter((component) => ctx.prefixOwners.has(component))) ctx.fail("core.json fault_components", `${name} is also a symptom prefix of ${ctx.prefixOwners.get(name)}, so a module ${name}.x would read as a symptom code`);
  const clashes = [...ctx.machines.keys()].filter((name) => ctx.events.has(name));
  for (const name of clashes) ctx.fail(`machine ${name}`, "a machine and an event share this name");
  const unknown = allowlist.incomplete.filter((entry) => !ctx.symptoms.has(entry.code));
  for (const entry of unknown) ctx.fail("coverage-allowlist.json", `${entry.code} is not a catalogued symptom`);
}

// Every envelope field counts against every dataset; an event's fields count against its own dataset.
function axiomBudget({ core, datasets, fields, events, fail }) {
  const envelopeNames = [...fields.values()].filter((field) => field.owner.startsWith("envelope.")).map((field) => field.name);
  const usedByDataset = new Map(datasets.map((dataset) => [dataset, new Set(envelopeNames)]));
  for (const event of events.values()) {
    if (event.test_only) continue;
    for (const name of Object.keys(event.fields)) usedByDataset.get(event.dataset)?.add(name);
  }
  return core.datasets.map((dataset) => {
    const names = [...usedByDataset.get(dataset.name)].sort();
    if (names.length > dataset.budget) fail(`dataset ${dataset.name}`, `uses ${names.length} fields, over its budget of ${dataset.budget}`);
    return { dataset: dataset.name, budget: dataset.budget, used: names.length, fields: names.map((name) => ({ name, type: AXIOM_TYPES[fields.get(name).type] })) };
  });
}

// ---------- Emitters ----------

const camel = (text) =>
  text
    .split(/[._]/)
    .map((part) => ({ id: "ID", sha: "SHA", sdk: "SDK", http: "HTTP", url: "URL", api: "API", ms: "Ms" })[part] ?? part.charAt(0).toUpperCase() + part.slice(1))
    .join("");

function eventLinks(model, name) {
  const event = model.events.find((entry) => entry.name === name) ?? { fields: {}, emit_sites: [] };
  return { name, fields: Object.keys(event.fields), emit_sites: event.emit_sites };
}

const factOf = (model, name) => model.facts.find((fact) => fact.name === name) ?? { events: [] };

function emitJson(model, axiom) {
  const live = (list) => list.filter((entry) => !entry.test_only);
  const coverage = {
    doc: "Generated: the chain each catalogued symptom must have. scripts/gates/obs-coverage.mjs checks that every link exists.",
    schema_ver: model.schema_ver,
    symptoms: live(model.symptoms).map((symptom) => ({
      code: symptom.code,
      area: symptom.area,
      slice: symptom.slice,
      allowlisted: model.incomplete.some((entry) => entry.code === symptom.code),
      item: symptom.item,
      per: symptom.per,
      witnesses: symptom.witnesses.map(({ fact, from, required }) => ({ fact, from, required, events: factOf(model, fact).events.map(({ event, source, fields }) => ({ event, source, fields })) })),
      events: [...new Set(symptom.witnesses.flatMap((witness) => factOf(model, witness.fact).events.map((entry) => entry.event)))].map((name) => eventLinks(model, name)),
      rule: symptom.rule,
      fixtures: symptom.fixtures,
      fault_scenario: symptom.fault_scenario,
    })),
  };
  const cli = {
    doc: "Generated: the tables the diagnosis CLI prints and resolves against.",
    schema_ver: model.schema_ver,
    symptoms: live(model.symptoms).map(({ code, area, slice, item, per, doc, user_words, witnesses, rule }) => ({
      code,
      area,
      slice,
      item,
      per,
      doc,
      user_words,
      witnesses: witnesses.map(({ fact, from, required }) => ({ fact, from, required })),
      rule,
      status: model.incomplete.some((entry) => entry.code === code) ? "incomplete" : "complete",
    })),
    reasons: live(model.reasons).map(({ code, outcome, area, doc }) => ({ code, outcome, area, doc })),
    id_kinds: model.id_kinds,
    session_meanings: model.session_meanings,
    diagnostic_code: model.diagnostic_code,
  };
  return {
    [`${GENERATED_DIR}/registry.json`]: model,
    [`${GENERATED_DIR}/axiom-fields.json`]: { doc: "Generated: the Axiom field schema per dataset and its budget. Envelope fields are in every dataset.", schema_ver: model.schema_ver, datasets: axiom },
    [`${GENERATED_DIR}/coverage-graph.json`]: coverage,
    [`${GENERATED_DIR}/cli-tables.json`]: cli,
  };
}

// The envelope group a field belongs to, or "event" for an area field.
const groupOf = (field) => (field.owner.startsWith("envelope.") ? field.owner.slice("envelope.".length) : "event");

const tsString = (value) => JSON.stringify(value);
const tsUnion = (values) => (values.length === 0 ? "never" : values.map(tsString).join(" | "));

const TS_TYPES = { string: "string", id: "string", int: "number", number: "number", bool: "boolean", map: "FlagMap", ranges: "readonly { readonly from: number; readonly to: number }[]" };
const tsFieldType = (field, values) => (field.type === "enum" ? tsUnion(values ?? field.values) : TS_TYPES[field.type]);
const TS_LISTS = [
  ["MODULES", "modules"],
  ["ENVIRONMENTS", "environments"],
  ["PLATFORMS", "platforms"],
  ["CLOCK_STATES", "clock_states"],
  ["KINDS", "kinds"],
  ["OUTCOMES", "outcomes"],
];

function tsEventFields(event, trail, fieldsByName) {
  const own = Object.entries(event.fields).map(([name, rule]) => `readonly ${name}${rule.required ? "" : "?"}: ${tsFieldType(fieldsByName.get(name), rule.values)}`);
  const shadowed = Object.keys(event.fields).filter((name) => trail.includes(name));
  const rest = shadowed.length === 0 ? "Trail" : `Omit<Trail, ${tsUnion(shadowed)}>`;
  return `  ${tsString(event.name)}: { ${own.join("; ")} } & ${rest};`;
}

function emitTypeScript(model) {
  const fieldsByName = new Map(model.fields.map((field) => [field.name, field]));
  const trail = model.envelope.find((group) => group.group === "trail").fields;
  const lines = [`// Generated by scripts/codegen/obs-registry.mjs from ${REGISTRY_DIR}. Do not edit.`, ""];
  lines.push(`export const SCHEMA_VER = ${tsString(model.schema_ver)};`);
  lines.push(...TS_LISTS.map(([name, key]) => `export const ${name} = ${tsString(model[key])} as const;`));
  lines.push(`export const CLOCK = { driftPpm: ${model.clock.drift_ppm}, jumpMs: ${model.clock.jump_ms} } as const;`);
  lines.push(`export const ID_KINDS = ${tsString(model.id_kinds.map(({ kind, prefix, field, canonical, legacy_hash_field }) => ({ kind, prefix, field, canonical, legacyHashField: legacy_hash_field })))} as const;`);
  lines.push(`export const SESSION_MEANINGS = ${tsString(model.session_meanings)} as const;`);
  lines.push(`export const DIAGNOSTIC_CODE = ${tsString(model.diagnostic_code)} as const;`);
  lines.push(`export const FIELDS = ${tsString(Object.fromEntries(model.fields.map((field) => [field.name, { type: field.type, ...present("values", field.values), group: groupOf(field), required: field.required }])))} as const;`);
  lines.push(`export const EVENTS = ${tsString(Object.fromEntries(model.events.map((event) => [event.name, { kind: event.kind, dataset: event.dataset, testOnly: event.test_only, decisions: event.decisions ?? [], fields: event.fields }])))} as const;`);
  lines.push(`export const MACHINES = ${tsString(Object.fromEntries(model.machines.map((machine) => [machine.name, { states: machine.states, initial: machine.initial, edges: machine.edges, triggers: machine.triggers }])))} as const;`);
  lines.push(`export const REASONS = ${tsString(Object.fromEntries(model.reasons.map((reason) => [reason.code, reason.outcome])))} as const;`);
  lines.push(`export const LEGACY = ${tsString(model.events.filter((event) => event.legacy).map((event) => ({ event: event.name, match: event.legacy.match })))} as const;`);
  lines.push("");
  lines.push("export type FlagValue = string | number | boolean | null;");
  lines.push("export type FlagMap = { readonly [key: string]: FlagValue };");
  lines.push("export type Module = (typeof MODULES)[number];");
  lines.push("export type Environment = (typeof ENVIRONMENTS)[number];");
  lines.push("export type Platform = (typeof PLATFORMS)[number];");
  lines.push("export type ClockState = (typeof CLOCK_STATES)[number];");
  lines.push("export type Kind = (typeof KINDS)[number];");
  lines.push("export type Outcome = (typeof OUTCOMES)[number];");
  lines.push('export type IdKind = (typeof ID_KINDS)[number]["kind"];');
  lines.push("export type EventName = keyof typeof EVENTS;");
  lines.push("export type FieldName = keyof typeof FIELDS;");
  lines.push(...["op", "decision", "surface", "fact"].map((kind) => `export type ${camel(kind)}Name = ${tsUnion(model.events.filter((event) => event.kind === kind).map((event) => event.name))};`));
  lines.push('export type DecisionValue<N extends DecisionName> = (typeof EVENTS)[N]["decisions"][number];');
  lines.push("export type MachineName = keyof typeof MACHINES;");
  lines.push('export type MachineState<M extends MachineName> = (typeof MACHINES)[M]["states"][number];');
  lines.push('export type MachineTrigger<M extends MachineName> = (typeof MACHINES)[M]["triggers"][number];');
  lines.push("export type ReasonCode = keyof typeof REASONS;");
  lines.push('export type ExpectedReason = { [K in ReasonCode]: (typeof REASONS)[K] extends "expected" ? K : never }[ReasonCode];');
  lines.push('export type ErrorReason = { [K in ReasonCode]: (typeof REASONS)[K] extends "error" ? K : never }[ReasonCode];');
  lines.push(`export type Trail = { ${trail.map((name) => `readonly ${name}?: ${tsFieldType(fieldsByName.get(name))}`).join("; ")} };`);
  lines.push("export type EventFields = {");
  lines.push(...model.events.map((event) => tsEventFields(event, trail, fieldsByName)), "};");
  return `${lines.join("\n")}\n`;
}

const goString = (value) => JSON.stringify(value);
const goStrings = (values) => `[]string{${values.map(goString).join(", ")}}`;
const goOptional = (key, values) => (values ? `, ${key}: ${goStrings(values)}` : "");
const goField = (field) => `\t${goString(field.name)}: {typ: ${goString(field.type)}, group: ${goString(groupOf(field))}, required: ${field.required}${goOptional("values", field.values)}},`;
const goRule = ([name, rule]) => `${goString(name)}: {required: ${rule.required}${goOptional("values", rule.values)}}`;
const goEvent = (event) => `\t${goString(event.name)}: {kind: ${goString(event.kind)}, dataset: ${goString(event.dataset)}, testOnly: ${event.test_only}${goOptional("decisions", event.decisions)}, fields: map[string]fieldRule{${Object.entries(event.fields).map(goRule).join(", ")}}},`;
const goEdges = (edges) => `[][2]string{${edges.map(([from, to]) => `{${goString(from)}, ${goString(to)}}`).join(", ")}}`;
const goMachine = (machine) => `\t${goString(machine.name)}: {states: ${goStrings(machine.states)}, edges: ${goEdges(machine.edges)}, triggers: ${goStrings(machine.triggers)}},`;
const goIdKind = (kind) => `\t{kind: ${goString(kind.kind)}, prefix: ${goString(kind.prefix)}, field: ${goString(kind.field)}, canonical: ${goString(kind.canonical)}, legacyHashField: ${goString(kind.legacy_hash_field ?? "")}},`;
const goSessionMeaning = (meaning) => `\t{meaning: ${goString(meaning.meaning)}, kind: ${goString(meaning.kind ?? "")}, lookup: ${meaning.lookup}},`;

function emitGo(model) {
  const out = [`// Code generated by scripts/codegen/obs-registry.mjs from ${REGISTRY_DIR}. DO NOT EDIT.`, "", "package obs", ""];
  out.push(`// SchemaVer is the registry's content hash, stamped on every record as schema_ver.`, `const SchemaVer = ${goString(model.schema_ver)}`, "");
  const block = (comment, entries) => {
    out.push(`// ${comment}`, "const (", ...entries.map(([name, value]) => `\t${name} = ${goString(value)}`), ")", "");
  };
  block(
    "Event names.",
    model.events.map((event) => [`Event${camel(event.name)}`, event.name]),
  );
  block(
    "Machine names.",
    model.machines.map((machine) => [`Machine${camel(machine.name)}`, machine.name]),
  );
  block(
    "Reason codes.",
    model.reasons.map((reason) => [`Reason${camel(reason.code)}`, reason.code]),
  );
  block(
    "Field names.",
    model.fields.map((field) => [`Field${camel(field.name)}`, field.name]),
  );
  const table = (declaration, lines) => out.push(`${declaration}{`, ...lines, "}", "");
  table("var registryFields = map[string]fieldSpec", model.fields.map(goField));
  table("var registryEvents = map[string]eventSpec", model.events.map(goEvent));
  table("var registryMachines = map[string]machineSpec", model.machines.map(goMachine));
  table(
    "var registryReasons = map[string]string",
    model.reasons.map((reason) => `\t${goString(reason.code)}: ${goString(reason.outcome)},`),
  );
  table("var registryIDKinds = []idKind", model.id_kinds.map(goIdKind));
  table("var registrySessionMeanings = []sessionMeaning", model.session_meanings.map(goSessionMeaning));
  out.push(`const (\n\tdiagnosticPrefix   = ${goString(model.diagnostic_code.prefix)}\n\tdiagnosticAlphabet = ${goString(model.diagnostic_code.alphabet)}\n\tdiagnosticLength   = ${model.diagnostic_code.length}\n)`, "");
  out.push(`var (\n\tregistryModules      = ${goStrings(model.modules)}\n\tregistryEnvironments = ${goStrings(model.environments)}\n\tregistryPlatforms    = ${goStrings(model.platforms)}\n)`, "");
  return out.join("\n");
}

const isScalar = (value) => typeof value !== "object" || value === null;

function exScalar(value) {
  if (value === null || value === undefined) return "nil";
  if (typeof value === "string") return JSON.stringify(value).replaceAll("#{", "\\#{");
  return String(value);
}

function exList(values, indent) {
  if (values.every(isScalar)) return `[${values.map((item) => exScalar(item)).join(", ")}]`;
  const next = `${indent}  `;
  return `[\n${values.map((item) => `${next}${exLiteral(item, next)}`).join(",\n")}\n${indent}]`;
}

function exMap(value, indent) {
  const entries = Object.entries(value);
  if (entries.length === 0) return "%{}";
  const next = `${indent}  `;
  return `%{\n${entries.map(([key, item]) => `${next}${JSON.stringify(key)} => ${exLiteral(item, next)}`).join(",\n")}\n${indent}}`;
}

function exLiteral(value, indent) {
  if (isScalar(value)) return exScalar(value);
  return Array.isArray(value) ? exList(value, indent) : exMap(value, indent);
}

function emitElixir(model) {
  const tables = {
    events: Object.fromEntries(model.events.map((event) => [event.name, { kind: event.kind, dataset: event.dataset, test_only: event.test_only, decisions: event.decisions ?? [], fields: event.fields }])),
    fields: Object.fromEntries(model.fields.map((field) => [field.name, { type: field.type, group: groupOf(field), required: field.required, values: field.values ?? null }])),
    machines: Object.fromEntries(model.machines.map((machine) => [machine.name, { states: machine.states, edges: machine.edges, triggers: machine.triggers }])),
    reasons: Object.fromEntries(model.reasons.map((reason) => [reason.code, reason.outcome])),
    id_kinds: model.id_kinds.map(({ kind, prefix, field, canonical, legacy_hash_field }) => ({ kind, prefix, field, canonical, legacy_hash_field })),
    session_meanings: model.session_meanings,
    diagnostic_code: model.diagnostic_code,
    modules: model.modules,
    environments: model.environments,
    platforms: model.platforms,
  };
  const lines = [`# Generated by scripts/codegen/obs-registry.mjs from ${REGISTRY_DIR}. Do not edit.`, "defmodule ChalkSync.Obs.Registry do", '  @moduledoc "The observability registry tables. See observability/registry/README.md."', "", `  @schema_ver ${JSON.stringify(model.schema_ver)}`];
  for (const [name, value] of Object.entries(tables)) lines.push("", `  @${name} ${exLiteral(value, "  ")}`);
  lines.push("", '  @doc "The registry\'s content hash, stamped on every record as schema_ver."', "  def schema_ver, do: @schema_ver");
  for (const name of Object.keys(tables)) lines.push(`  @doc false`, `  def ${name}, do: @${name}`);
  lines.push("end", "");
  return lines.join("\n");
}

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
