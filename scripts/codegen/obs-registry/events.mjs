// fallow-ignore-file complexity -- each branch is one registry check; obs-registry.test.mjs covers them, which the CRAP estimate cannot see.
// Checks each area of the registry: its events, facts and symptoms, their cross references and the Axiom field budget.
import { FACT_KINDS, FACT_PERS, SIDES, NAME, AXIOM_TYPES, problemsOf, report, present, isNonEmptyList, allNames, hasDoc, isDotted, SYMPTOM_CODE, addField, addReason, addMachine } from "./shape.mjs";

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

export function addArea(ctx, area) {
  const normalized = { area: area.area, slice: area.slice, title: area.title ?? "", prefixes: area.prefixes ?? [], test_only: area.test_only === true };
  const where = `areas/${area.file}`;
  report(ctx.fail, where, problemsOf(AREA_CHECKS, area));
  for (const prefix of normalized.prefixes) claimPrefix(ctx, where, area.area, prefix);
  const owns = (code) => normalized.prefixes.some((prefix) => code.startsWith(`${prefix}.`));
  addParts({ ...ctx, where, area: normalized, testOnly: normalized.test_only, owns }, area);
  return normalized;
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
export function checkCrossReferences(ctx, allowlist) {
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
export function axiomBudget({ core, datasets, fields, events, fail }) {
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
