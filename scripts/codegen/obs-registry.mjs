// Generates every observability artifact from observability/registry: the typed kernel tables
// for TypeScript, Go and Elixir, the Go kernel copies, the Axiom field schema and budget, the
// coverage graph and the CLI's symptom and reason tables.
// Usage: node scripts/codegen/obs-registry.mjs [--write]
// Without --write it exits non-zero when any output differs from what is committed.
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { repositoryRoot } from "../lib/repository.mjs";

const REGISTRY_DIR = "observability/registry";
const GENERATED_DIR = "observability/generated";
const GO_KERNEL_DIR = "observability/kernel/go";
const GO_TARGETS = ["apps/api/internal/obs", "features/media/sfu/internal/obs"];
const TS_REGISTRY = "sdks/typescript/client/src/obs/registry.ts";
const EX_REGISTRY = "apps/sync/lib/chalk_sync/obs/registry.ex";

const FIELD_TYPES = new Set(["string", "int", "number", "bool", "enum", "id", "map"]);
const SIDES = new Set(["client", "server", "any"]);
const BANNED_UNIT_SUFFIXES = ["_s", "_sec", "_secs", "_seconds", "_millis", "_us", "_kb", "_mb", "_kbps", "_mbps", "_percent"];
const NAME = /^[a-z][a-z0-9_]*$/;
const DOTTED = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const AXIOM_TYPES = { string: "string", int: "integer", number: "float", bool: "boolean", enum: "string", id: "string", map: "map" };

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
  const errors = [];
  const fail = (where, message) => errors.push(`${where}: ${message}`);
  const { core, ids, envelope, allowlist, areas } = source;

  const kinds = core.kinds.map((entry) => entry.kind);
  const outcomes = core.outcomes.map((entry) => entry.outcome);
  const datasets = core.datasets.map((entry) => entry.name);
  const enumSources = {
    "core.modules": core.modules,
    "core.environments": core.environments,
    "core.platforms": core.platforms,
    "core.clock_states": core.clock_states.map((entry) => entry.state),
    "core.kinds": kinds,
    "core.outcomes": outcomes,
    "core.surface_states": core.surface_states,
  };
  const idKinds = new Map(ids.kinds.map((entry) => [entry.kind, entry]));

  const fields = new Map();
  const addField = (where, field, owner) => {
    if (!NAME.test(field.name ?? "")) return fail(where, `field name ${JSON.stringify(field.name)} must be snake_case`);
    if (fields.has(field.name)) return fail(where, `field ${field.name} is already declared by ${fields.get(field.name).owner}`);
    if (BANNED_UNIT_SUFFIXES.some((suffix) => field.name.endsWith(suffix))) fail(where, `field ${field.name} uses a banned unit suffix; use _ms, _bytes, _bps or _pct`);
    if (!FIELD_TYPES.has(field.type)) fail(where, `field ${field.name} has unknown type ${JSON.stringify(field.type)}`);
    if (!("sensitivity" in field)) fail(where, `field ${field.name} needs a sensitivity slot (null until the privacy pass)`);
    else if (field.sensitivity !== null && !core.sensitivity_levels.includes(field.sensitivity)) fail(where, `field ${field.name} has unknown sensitivity ${JSON.stringify(field.sensitivity)}`);
    let values;
    if (field.type === "enum") {
      values = field.values_from ? enumSources[field.values_from] : field.values;
      if (!Array.isArray(values) || values.length === 0) fail(where, `enum field ${field.name} needs values or a known values_from`);
    } else if (field.values || field.values_from) fail(where, `field ${field.name} is not an enum but declares values`);
    if (field.type === "id" && !idKinds.has(field.id_kind)) fail(where, `id field ${field.name} has unknown id_kind ${JSON.stringify(field.id_kind)}`);
    if (typeof field.doc !== "string" || field.doc.length === 0) fail(where, `field ${field.name} needs a doc`);
    fields.set(field.name, {
      name: field.name,
      type: field.type,
      ...(values ? { values: [...values] } : {}),
      ...(field.id_kind ? { id_kind: field.id_kind } : {}),
      ...(field.legacy_names ? { legacy_names: field.legacy_names } : {}),
      required: field.required === true,
      sensitivity: field.sensitivity ?? null,
      owner,
      doc: field.doc,
    });
  };

  const envelopeGroups = [];
  for (const group of envelope.groups) {
    for (const field of group.fields) addField(`envelope.json ${group.group}`, field, `envelope.${group.group}`);
    envelopeGroups.push({ group: group.group, fields: group.fields.map((field) => field.name) });
  }
  const recordFields = new Set(envelope.groups.find((group) => group.group === "record").fields.map((field) => field.name));

  const reasons = new Map(core.reserved_reasons.map((entry) => [entry.code, { code: entry.code, outcome: entry.outcome, area: "core", test_only: false, doc: entry.doc }]));
  const events = new Map();
  const machines = new Map();
  const symptoms = new Map();
  const prefixOwners = new Map();
  const normalizedAreas = [];

  for (const area of areas) {
    const where = `areas/${area.file}`;
    if (`${area.area}.json` !== area.file) fail(where, `area ${JSON.stringify(area.area)} must live in areas/${area.area}.json`);
    if (!Number.isInteger(area.slice)) fail(where, "slice must be the plan's slice number (0 for the foundation)");
    const testOnly = area.test_only === true;
    for (const prefix of area.prefixes ?? []) {
      if (!NAME.test(prefix)) fail(where, `prefix ${JSON.stringify(prefix)} must be snake_case`);
      if (prefixOwners.has(prefix)) fail(where, `prefix ${prefix} is already owned by ${prefixOwners.get(prefix)}`);
      prefixOwners.set(prefix, area.area);
    }
    const owns = (code) => (area.prefixes ?? []).some((prefix) => code.startsWith(`${prefix}.`));
    for (const field of area.fields ?? []) addField(where, field, `areas/${area.area}`);

    for (const reason of area.reasons ?? []) {
      if (!DOTTED.test(reason.code ?? "")) fail(where, `reason ${JSON.stringify(reason.code)} must be dotted snake_case`);
      else if (!owns(reason.code)) fail(where, `reason ${reason.code} must start with one of this area's prefixes (${area.prefixes.join(", ")})`);
      if (reasons.has(reason.code)) fail(where, `reason ${reason.code} is declared twice`);
      if (reason.outcome !== "expected" && reason.outcome !== "error") fail(where, `reason ${reason.code} outcome must be expected or error`);
      reasons.set(reason.code, { code: reason.code, outcome: reason.outcome, area: area.area, test_only: testOnly, doc: reason.doc ?? "" });
    }

    for (const machine of area.machines ?? []) {
      const at = `${where} machine ${machine.name}`;
      if (!DOTTED.test(machine.name ?? "")) fail(at, "machine name must be dotted snake_case");
      if (machines.has(machine.name)) fail(at, "machine is declared twice");
      const states = machine.states ?? [];
      if (states.length < 2 || new Set(states).size !== states.length || !states.every((state) => NAME.test(state))) fail(at, "states must be at least two unique snake_case names");
      if (!states.includes(machine.initial)) fail(at, `initial state ${JSON.stringify(machine.initial)} is not a state`);
      const seen = new Set();
      for (const edge of machine.edges ?? []) {
        const [from, to] = edge;
        if (edge.length !== 2 || !states.includes(from) || !states.includes(to)) fail(at, `edge ${JSON.stringify(edge)} must join two declared states`);
        if (from === to) fail(at, `edge ${from} -> ${to} is a self-loop; the owner emits only real changes`);
        if (seen.has(`${from}>${to}`)) fail(at, `edge ${from} -> ${to} is declared twice`);
        seen.add(`${from}>${to}`);
      }
      if (!Array.isArray(machine.triggers) || machine.triggers.length === 0 || !machine.triggers.every((trigger) => NAME.test(trigger))) fail(at, "triggers must be a non-empty list of snake_case names");
      machines.set(machine.name, { name: machine.name, area: area.area, test_only: testOnly, states, initial: machine.initial, edges: machine.edges ?? [], triggers: machine.triggers ?? [], doc: machine.doc ?? "" });
    }

    for (const event of area.events ?? []) {
      const at = `${where} event ${event.name}`;
      if (!DOTTED.test(event.name ?? "")) fail(at, "event name must be dotted snake_case");
      if (events.has(event.name)) fail(at, `event is already declared by areas/${events.get(event.name).area}.json`);
      if (!kinds.includes(event.kind) || event.kind === "transition") fail(at, `kind must be one of ${kinds.filter((kind) => kind !== "transition").join(", ")}; a transition is declared as a machine`);
      if (!datasets.includes(event.dataset)) fail(at, `dataset must be one of ${datasets.join(", ")}`);
      if (!SIDES.has(event.side)) fail(at, "side must be client, server or any");
      for (const module of event.modules ?? []) if (!core.modules.includes(module)) fail(at, `unknown module ${module}`);
      if (event.kind === "decision" && !(Array.isArray(event.decisions) && event.decisions.length > 0 && event.decisions.every((value) => NAME.test(value)))) fail(at, "a decision event needs a non-empty decisions list");
      if (event.kind !== "decision" && event.decisions) fail(at, "only a decision event declares decisions");
      const eventFields = {};
      for (const [name, rule] of Object.entries(event.fields ?? {})) {
        const field = fields.get(name);
        if (!field) {
          fail(at, `field ${name} is not declared in envelope.json or an area's fields`);
          continue;
        }
        if (recordFields.has(name)) fail(at, `field ${name} is stamped by the kernel and cannot be declared on an event`);
        if (rule.values && (field.type !== "enum" || !rule.values.every((value) => field.values?.includes(value)))) fail(at, `values for ${name} must be a subset of the field's enum values`);
        eventFields[name] = { required: rule.required === true, ...(rule.values ? { values: rule.values } : {}) };
      }
      for (const site of event.emit_sites ?? []) if (typeof site.path !== "string" || typeof site.literal !== "string") fail(at, "each emit site needs a path and a literal");
      if (event.legacy && (typeof event.legacy.match !== "object" || Object.values(event.legacy.match).some((value) => typeof value !== "string"))) fail(at, "legacy.match must map field names to strings");
      events.set(event.name, {
        name: event.name,
        kind: event.kind,
        dataset: event.dataset,
        side: event.side,
        modules: event.modules ?? [],
        area: area.area,
        test_only: testOnly,
        ...(event.decisions ? { decisions: event.decisions } : {}),
        fields: eventFields,
        emit_sites: event.emit_sites ?? [],
        ...(event.legacy ? { legacy: event.legacy } : {}),
        doc: event.doc ?? "",
      });
    }

    for (const symptom of area.symptoms ?? []) {
      const at = `${where} symptom ${symptom.code}`;
      if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(symptom.code ?? "")) fail(at, "symptom code must be <prefix>.<snake_case>");
      else if (!owns(symptom.code)) fail(at, `symptom code must start with one of this area's prefixes (${area.prefixes.join(", ")})`);
      if (symptoms.has(symptom.code)) fail(at, "symptom is declared twice");
      if (typeof symptom.doc !== "string" || symptom.doc.length === 0) fail(at, "symptom needs a doc");
      const witnessIds = new Set();
      for (const witness of symptom.witnesses ?? []) {
        if (!NAME.test(witness.id ?? "") || witnessIds.has(witness.id)) fail(at, `witness id ${JSON.stringify(witness.id)} must be unique snake_case`);
        witnessIds.add(witness.id);
        if (typeof witness.required !== "boolean") fail(at, `witness ${witness.id} must say whether it is required`);
      }
      symptoms.set(symptom.code, {
        code: symptom.code,
        area: area.area,
        slice: area.slice,
        doc: symptom.doc,
        user_words: symptom.user_words ?? [],
        witnesses: (symptom.witnesses ?? []).map((witness) => ({ id: witness.id, event: witness.event, fields: witness.fields ?? [], required: witness.required, doc: witness.doc ?? "" })),
        rule: `observability/rules/${symptom.code}.mjs`,
        fixtures: { positive: `observability/fixtures/${symptom.code}/positive.json`, healthy: `observability/fixtures/${symptom.code}/healthy.json` },
        fault_scenario: symptom.fault_scenario ?? null,
      });
    }
    normalizedAreas.push({ area: area.area, slice: area.slice, title: area.title ?? "", prefixes: area.prefixes ?? [], test_only: testOnly });
  }

  // Witnesses can only be checked once every area's events are known.
  for (const symptom of symptoms.values()) {
    for (const witness of symptom.witnesses) {
      const event = events.get(witness.event);
      if (!event) {
        fail(`symptom ${symptom.code}`, `witness ${witness.id} names unknown event ${witness.event}`);
        continue;
      }
      for (const name of witness.fields) {
        const isEnvelope = fields.get(name)?.owner.startsWith("envelope.");
        if (!(name in event.fields) && !isEnvelope) fail(`symptom ${symptom.code}`, `witness ${witness.id} field ${name} is neither on ${event.name} nor in the envelope`);
      }
    }
  }
  for (const machine of machines.values()) if (events.has(machine.name)) fail(`machine ${machine.name}`, "a machine and an event share this name");
  for (const entry of allowlist.incomplete) if (!symptoms.has(entry.code)) fail("coverage-allowlist.json", `${entry.code} is not a catalogued symptom`);

  const usedByDataset = new Map(datasets.map((dataset) => [dataset, new Set([...fields.values()].filter((field) => field.owner.startsWith("envelope.")).map((field) => field.name))]));
  for (const event of events.values()) if (!event.test_only) for (const name of Object.keys(event.fields)) usedByDataset.get(event.dataset)?.add(name);
  const axiom = core.datasets.map((dataset) => {
    const names = [...usedByDataset.get(dataset.name)].sort();
    if (names.length > dataset.budget) fail(`dataset ${dataset.name}`, `uses ${names.length} fields, over its budget of ${dataset.budget}`);
    return { dataset: dataset.name, budget: dataset.budget, used: names.length, fields: names.map((name) => ({ name, type: AXIOM_TYPES[fields.get(name).type] })) };
  });

  const sorted = (map) => [...map.values()].sort((a, b) => (a.name ?? a.code).localeCompare(b.name ?? b.code));
  const model = {
    kinds,
    outcomes,
    surface_states: core.surface_states,
    datasets: core.datasets.map(({ name, budget }) => ({ name, budget })),
    modules: core.modules,
    platforms: core.platforms,
    environments: core.environments,
    clock_states: enumSources["core.clock_states"],
    clock: { drift_ppm: core.clock.drift_ppm, jump_ms: core.clock.jump_ms },
    sensitivity_levels: core.sensitivity_levels,
    id_kinds: ids.kinds.map(({ kind, prefix, field, canonical, scope, companions, legacy_hash_field }) => ({ kind, prefix, field, canonical, scope: scope ?? null, companions: companions ?? [], legacy_hash_field: legacy_hash_field ?? null })),
    session_meanings: ids.session_meanings.map(({ meaning, kind, lookup }) => ({ meaning, kind, lookup })),
    diagnostic_code: { prefix: ids.diagnostic_code.prefix, length: ids.diagnostic_code.length, alphabet: ids.diagnostic_code.alphabet, source_kind: ids.diagnostic_code.source_kind },
    envelope: envelopeGroups,
    areas: normalizedAreas.sort((a, b) => a.area.localeCompare(b.area)),
    fields: [...fields.values()].sort((a, b) => a.name.localeCompare(b.name)),
    reasons: sorted(reasons),
    events: sorted(events),
    machines: sorted(machines),
    symptoms: sorted(symptoms),
    incomplete: allowlist.incomplete.map(({ code, slice }) => ({ code, slice })).sort((a, b) => a.code.localeCompare(b.code)),
  };
  const schemaVer = createHash("sha256").update(JSON.stringify(model)).digest("hex").slice(0, 12);
  return { errors, model: { schema_ver: schemaVer, ...model }, axiom };
}

// ---------- Emitters ----------

const camel = (text) =>
  text
    .split(/[._]/)
    .map((part) => ({ id: "ID", sha: "SHA", sdk: "SDK", http: "HTTP", url: "URL", api: "API", ms: "Ms" })[part] ?? part.charAt(0).toUpperCase() + part.slice(1))
    .join("");

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
      witnesses: symptom.witnesses.map(({ id, event, fields, required }) => ({ id, event, fields, required })),
      events: [...new Set(symptom.witnesses.map((witness) => witness.event))].map((name) => {
        const event = model.events.find((entry) => entry.name === name);
        return { name, fields: Object.keys(event?.fields ?? {}), emit_sites: event?.emit_sites ?? [] };
      }),
      rule: symptom.rule,
      fixtures: symptom.fixtures,
      fault_scenario: symptom.fault_scenario,
    })),
  };
  const cli = {
    doc: "Generated: the tables the diagnosis CLI prints and resolves against.",
    schema_ver: model.schema_ver,
    symptoms: live(model.symptoms).map(({ code, area, slice, doc, user_words, witnesses, rule }) => ({
      code,
      area,
      slice,
      doc,
      user_words,
      witnesses: witnesses.map(({ id, event, required }) => ({ id, event, required })),
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

function tsFieldType(field, values) {
  if (field.type === "enum") return tsUnion(values ?? field.values);
  if (field.type === "int" || field.type === "number") return "number";
  if (field.type === "bool") return "boolean";
  if (field.type === "map") return "FlagMap";
  return "string";
}

function emitTypeScript(model) {
  const fieldsByName = new Map(model.fields.map((field) => [field.name, field]));
  const trail = model.envelope.find((group) => group.group === "trail").fields;
  const lines = [`// Generated by scripts/codegen/obs-registry.mjs from ${REGISTRY_DIR}. Do not edit.`, ""];
  lines.push(`export const SCHEMA_VER = ${tsString(model.schema_ver)};`);
  for (const [name, values] of [
    ["MODULES", model.modules],
    ["ENVIRONMENTS", model.environments],
    ["PLATFORMS", model.platforms],
    ["CLOCK_STATES", model.clock_states],
    ["KINDS", model.kinds],
    ["OUTCOMES", model.outcomes],
  ])
    lines.push(`export const ${name} = ${tsString(values)} as const;`);
  lines.push(`export const CLOCK = { driftPpm: ${model.clock.drift_ppm}, jumpMs: ${model.clock.jump_ms} } as const;`);
  lines.push(`export const ID_KINDS = ${tsString(model.id_kinds.map(({ kind, prefix, field, canonical, legacy_hash_field }) => ({ kind, prefix, field, canonical, legacyHashField: legacy_hash_field })))} as const;`);
  lines.push(`export const SESSION_MEANINGS = ${tsString(model.session_meanings)} as const;`);
  lines.push(`export const DIAGNOSTIC_CODE = ${tsString(model.diagnostic_code)} as const;`);
  lines.push(`export const FIELDS = ${tsString(Object.fromEntries(model.fields.map((field) => [field.name, { type: field.type, ...(field.values ? { values: field.values } : {}), group: groupOf(field), required: field.required }])))} as const;`);
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
  for (const kind of ["op", "decision", "surface", "fact"]) lines.push(`export type ${camel(kind)}Name = ${tsUnion(model.events.filter((event) => event.kind === kind).map((event) => event.name))};`);
  lines.push('export type DecisionValue<N extends DecisionName> = (typeof EVENTS)[N]["decisions"][number];');
  lines.push("export type MachineName = keyof typeof MACHINES;");
  lines.push('export type MachineState<M extends MachineName> = (typeof MACHINES)[M]["states"][number];');
  lines.push('export type MachineTrigger<M extends MachineName> = (typeof MACHINES)[M]["triggers"][number];');
  lines.push("export type ReasonCode = keyof typeof REASONS;");
  lines.push('export type ExpectedReason = { [K in ReasonCode]: (typeof REASONS)[K] extends "expected" ? K : never }[ReasonCode];');
  lines.push('export type ErrorReason = { [K in ReasonCode]: (typeof REASONS)[K] extends "error" ? K : never }[ReasonCode];');
  lines.push(`export type Trail = { ${trail.map((name) => `readonly ${name}?: ${tsFieldType(fieldsByName.get(name))}`).join("; ")} };`);
  lines.push("export type EventFields = {");
  for (const event of model.events) {
    const own = Object.entries(event.fields).map(([name, rule]) => `readonly ${name}${rule.required ? "" : "?"}: ${tsFieldType(fieldsByName.get(name), rule.values)}`);
    const shadowed = Object.keys(event.fields).filter((name) => trail.includes(name));
    const rest = shadowed.length === 0 ? "Trail" : `Omit<Trail, ${tsUnion(shadowed)}>`;
    lines.push(`  ${tsString(event.name)}: { ${own.join("; ")} } & ${rest};`);
  }
  lines.push("};");
  return `${lines.join("\n")}\n`;
}

const goString = (value) => JSON.stringify(value);
const goStrings = (values) => `[]string{${values.map(goString).join(", ")}}`;

function emitGo(model) {
  const out = [`// Code generated by scripts/codegen/obs-registry.mjs from ${REGISTRY_DIR}. DO NOT EDIT.`, "", "package obs", ""];
  out.push(`// SchemaVer is the registry's content hash, stamped on every record as schema_ver.`, `const SchemaVer = ${goString(model.schema_ver)}`, "");
  const block = (comment, entries) => {
    out.push(`// ${comment}`, "const (");
    for (const [name, value] of entries) out.push(`\t${name} = ${goString(value)}`);
    out.push(")", "");
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
  out.push("var registryFields = map[string]fieldSpec{");
  for (const field of model.fields) out.push(`\t${goString(field.name)}: {typ: ${goString(field.type)}, group: ${goString(groupOf(field))}, required: ${field.required}${field.values ? `, values: ${goStrings(field.values)}` : ""}},`);
  out.push("}", "", "var registryEvents = map[string]eventSpec{");
  for (const event of model.events) {
    const rules = Object.entries(event.fields).map(([name, rule]) => `${goString(name)}: {required: ${rule.required}${rule.values ? `, values: ${goStrings(rule.values)}` : ""}}`);
    out.push(`\t${goString(event.name)}: {kind: ${goString(event.kind)}, dataset: ${goString(event.dataset)}, testOnly: ${event.test_only}${event.decisions ? `, decisions: ${goStrings(event.decisions)}` : ""}, fields: map[string]fieldRule{${rules.join(", ")}}},`);
  }
  out.push("}", "", "var registryMachines = map[string]machineSpec{");
  for (const machine of model.machines) out.push(`\t${goString(machine.name)}: {states: ${goStrings(machine.states)}, edges: [][2]string{${machine.edges.map(([from, to]) => `{${goString(from)}, ${goString(to)}}`).join(", ")}}, triggers: ${goStrings(machine.triggers)}},`);
  out.push("}", "", "var registryReasons = map[string]string{");
  for (const reason of model.reasons) out.push(`\t${goString(reason.code)}: ${goString(reason.outcome)},`);
  out.push("}", "", "var registryIDKinds = []idKind{");
  for (const kind of model.id_kinds) out.push(`\t{kind: ${goString(kind.kind)}, prefix: ${goString(kind.prefix)}, field: ${goString(kind.field)}, canonical: ${goString(kind.canonical)}, legacyHashField: ${goString(kind.legacy_hash_field ?? "")}},`);
  out.push("}", "", "var registrySessionMeanings = []sessionMeaning{");
  for (const meaning of model.session_meanings) out.push(`\t{meaning: ${goString(meaning.meaning)}, kind: ${goString(meaning.kind ?? "")}, lookup: ${meaning.lookup}},`);
  out.push("}", "");
  out.push(`const (\n\tdiagnosticPrefix   = ${goString(model.diagnostic_code.prefix)}\n\tdiagnosticAlphabet = ${goString(model.diagnostic_code.alphabet)}\n\tdiagnosticLength   = ${model.diagnostic_code.length}\n)`, "");
  out.push(`var (\n\tregistryModules      = ${goStrings(model.modules)}\n\tregistryEnvironments = ${goStrings(model.environments)}\n\tregistryPlatforms    = ${goStrings(model.platforms)}\n)`, "");
  return out.join("\n");
}

function exLiteral(value, indent = "") {
  const next = `${indent}  `;
  if (value === null || value === undefined) return "nil";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value).replaceAll("#{", "\\#{");
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item !== "object" || item === null)) return `[${value.map((item) => exLiteral(item)).join(", ")}]`;
    return `[\n${value.map((item) => `${next}${exLiteral(item, next)}`).join(",\n")}\n${indent}]`;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return "%{}";
  return `%{\n${entries.map(([key, item]) => `${next}${JSON.stringify(key)} => ${exLiteral(item, next)}`).join(",\n")}\n${indent}}`;
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

// Formats in a scratch directory so the comparison sees exactly what --write would commit.
async function formatted(outputs) {
  const scratch = await mkdtemp(join(tmpdir(), "obs-registry-"));
  try {
    for (const [path, content] of Object.entries(outputs)) {
      await mkdir(dirname(join(scratch, path)), { recursive: true });
      await writeFile(join(scratch, path), content);
    }
    const paths = Object.keys(outputs);
    const prettier = paths.filter((path) => path.endsWith(".ts") || path.endsWith(".json")).map((path) => join(scratch, path));
    const go = paths.filter((path) => path.endsWith(".go")).map((path) => join(scratch, path));
    const oxfmt = spawnSync("pnpm", ["exec", "oxfmt", "--config", join(repositoryRoot, ".oxfmtrc.json"), "--write", ...prettier], { cwd: repositoryRoot, encoding: "utf8" });
    if (oxfmt.status !== 0) throw new Error(`oxfmt failed:\n${oxfmt.stdout}${oxfmt.stderr}`);
    const gofmt = spawnSync("gofmt", ["-w", ...go], { encoding: "utf8" });
    if (gofmt.status !== 0) throw new Error(`gofmt failed:\n${gofmt.stdout}${gofmt.stderr}`);
    const result = {};
    for (const path of paths) result[path] = await readFile(join(scratch, path), "utf8");
    return result;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function main() {
  const write = process.argv.includes("--write");
  const { errors, outputs } = await generate();
  if (errors.length > 0) {
    console.error(`observability registry has ${errors.length} problem(s):\n${errors.map((error) => `  - ${error}`).join("\n")}`);
    process.exit(1);
  }
  const files = await formatted(outputs);
  const stale = [];
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(repositoryRoot, path);
    const current = await readFile(absolute, "utf8").catch(() => null);
    if (current === content) continue;
    if (write) {
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, content);
    }
    stale.push(relative(repositoryRoot, absolute));
  }
  if (write) {
    console.log(stale.length === 0 ? "observability registry outputs are current" : `wrote ${stale.join(", ")}`);
  } else if (stale.length > 0) {
    console.error(`observability registry outputs are stale: ${stale.join(", ")}\nRun pnpm run regen.`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
