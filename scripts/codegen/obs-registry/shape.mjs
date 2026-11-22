// Checks the registry's fields, reasons and machines, and the small predicates every check shares.

const FIELD_TYPES = new Set(["string", "int", "number", "bool", "enum", "id", "map", "ranges"]);

export const FACT_KINDS = new Set(["once", "state", "aggregate", "event"]);

export const FACT_PERS = new Set(["seat", "item", "any"]);

export const SIDES = new Set(["client", "server", "any"]);

const BANNED_UNIT_SUFFIXES = ["_s", "_sec", "_secs", "_seconds", "_millis", "_us", "_kb", "_mb", "_kbps", "_mbps", "_percent"];

export const NAME = /^[a-z][a-z0-9_]*$/;

const DOTTED = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export const AXIOM_TYPES = { string: "string", int: "integer", number: "float", bool: "boolean", enum: "string", id: "string", map: "map", ranges: "array" };

// Each check is [passes(subject, scope), message(subject, scope)]. A validator is a list of checks, and it reports
// every check that does not pass; a message may be a list when one check finds several problems.
export const problemsOf = (checks, subject, scope) => checks.filter(([passes]) => !passes(subject, scope)).flatMap(([, message]) => message(subject, scope));

export const report = (fail, where, problems) => {
  for (const problem of problems) fail(where, problem);
};

export const present = (key, value) => (value ? { [key]: value } : {});

export const isNonEmptyList = (value) => Array.isArray(value) && value.length > 0;

export const allNames = (values) => isNonEmptyList(values) && values.every((value) => NAME.test(value));

export const hasDoc = (entry) => typeof entry.doc === "string" && entry.doc.length > 0;

export const isDotted = (value) => DOTTED.test(value ?? "");

export const SYMPTOM_CODE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

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

export function addField(ctx, where, field, owner) {
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

const REASON_CHECKS = [
  [(reason) => isDotted(reason.code), (reason) => `reason ${JSON.stringify(reason.code)} must be dotted snake_case`],
  [(reason, { owns }) => !isDotted(reason.code) || owns(reason.code), (reason, { area }) => `reason ${reason.code} must start with one of this area's prefixes (${area.prefixes.join(", ")})`],
  [(reason, { reasons }) => !reasons.has(reason.code), (reason) => `reason ${reason.code} is declared twice`],
  [(reason) => reason.outcome === "expected" || reason.outcome === "error", (reason) => `reason ${reason.code} outcome must be expected or error`],
];

export function addReason(scope, reason) {
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

export function addMachine(scope, declared) {
  const machine = { states: [], edges: [], triggers: [], doc: "", ...declared };
  const problems = [...problemsOf(MACHINE_CHECKS, machine, scope), ...edgeProblems(machine.states, machine.edges)];
  report(scope.fail, `${scope.where} machine ${machine.name}`, problems);
  const { name, states, initial, edges, triggers, doc } = machine;
  scope.machines.set(name, { name, area: scope.area.area, test_only: scope.testOnly, states, initial, edges, triggers, doc });
}
