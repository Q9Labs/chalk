import { EVENTS, FIELDS, MACHINES, REASONS, type FlagMap, type FlagValue, type Kind, type Outcome } from "./registry.ts";

// How the kernel checks a call against the generated registry: events, their fields, machine edges and reason codes.
// Each function returns the problems it found, and the kernel decides whether to throw or count them.

type FieldRule = { readonly required: boolean; readonly values?: readonly string[] };
type EventSpec = { readonly kind: Kind; readonly decisions: readonly string[]; readonly fields: { readonly [name: string]: FieldRule } };
type FieldSpec = { readonly type: string; readonly group: string; readonly values?: readonly string[] };
type MachineSpec = { readonly states: readonly string[]; readonly edges: readonly (readonly string[])[]; readonly triggers: readonly string[] };

export const EVENT_SPECS: ReadonlyMap<string, EventSpec> = new Map(Object.entries(EVENTS));
const FIELD_SPECS: ReadonlyMap<string, FieldSpec> = new Map(Object.entries(FIELDS));
const MACHINE_SPECS: ReadonlyMap<string, MachineSpec> = new Map(Object.entries(MACHINES));
const REASON_SPECS: ReadonlyMap<string, Outcome> = new Map(Object.entries(REASONS));

export const entriesOf = (value: object): [string, unknown][] => Object.entries(value);

const isFlagValue = (value: unknown): value is FlagValue => value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));

export function isFlagMap(value: unknown): value is FlagMap {
  return typeof value === "object" && value !== null && !Array.isArray(value) && entriesOf(value).every(([, member]) => isFlagValue(member));
}

const nonEmptyString = (value: unknown) => typeof value === "string" && value.length > 0;
const FITS: { readonly [type: string]: (value: unknown, allowed: readonly string[]) => boolean } = {
  enum: (value, allowed) => typeof value === "string" && allowed.includes(value),
  int: (value) => typeof value === "number" && Number.isSafeInteger(value),
  number: (value) => typeof value === "number" && Number.isFinite(value),
  bool: (value) => typeof value === "boolean",
  string: nonEmptyString,
  id: nonEmptyString,
  map: isFlagMap,
};

function valueProblem(field: string, value: unknown, spec: FieldSpec, allowed: readonly string[]): string | undefined {
  if (FITS[spec.type]?.(value, allowed) === true) return undefined;
  const choices = spec.type === "enum" ? ` (${allowed.join(", ")})` : "";
  return `field ${field} has ${JSON.stringify(value)}, which is not a valid ${spec.type}${choices}`;
}

export const isDefined = <T>(value: T | undefined): value is T => value !== undefined;

function givenFieldProblem(name: string, field: string, value: unknown, rules: { readonly [name: string]: FieldRule }): string | undefined {
  const spec = FIELD_SPECS.get(field);
  if (!spec) return `${name}: field ${field} is not in the registry`;
  const rule = rules[field];
  if (!rule && spec.group !== "trail") return `${name}: field ${field} is not declared on this event`;
  const problem = valueProblem(field, value, spec, rule?.values ?? spec.values ?? []);
  return problem === undefined ? undefined : `${name}: ${problem}`;
}

// Checks caller-supplied fields: trail fields anywhere, event fields only on their event.
function fieldProblems(name: string, fields: object, rules: { readonly [name: string]: FieldRule }): string[] {
  const given = entriesOf(fields).filter(([, value]) => value !== undefined);
  const supplied = new Set(given.map(([field]) => field));
  const missing = Object.entries(rules).filter(([field, rule]) => rule.required && !supplied.has(field));
  return [...given.map(([field, value]) => givenFieldProblem(name, field, value, rules)).filter(isDefined), ...missing.map(([field]) => `${name}: required field ${field} is missing`)];
}

export function machineProblems(machine: string, from: string, to: string, trigger: string, fields: object): string[] {
  const spec = MACHINE_SPECS.get(machine);
  if (!spec) return [`unknown machine ${machine}`];
  const problems = fieldProblems(machine, fields, {});
  if (!spec.edges.some(([edgeFrom, edgeTo]) => edgeFrom === from && edgeTo === to)) problems.push(`${machine}: ${from} -> ${to} is not a declared edge`);
  if (!spec.triggers.includes(trigger)) problems.push(`${machine}: unknown trigger ${trigger}`);
  return problems;
}

export function eventProblems(name: string, kind: Kind, fields: object): string[] {
  const spec = EVENT_SPECS.get(name);
  if (!spec) return [`unknown event ${name}`];
  if (spec.kind !== kind) return [`${name} is a ${spec.kind}, not a ${kind}`];
  return fieldProblems(name, fields, spec.fields);
}

export function reasonProblem(code: string | undefined, outcome?: Outcome): string | undefined {
  if (code === undefined) return undefined;
  const known = REASON_SPECS.get(code);
  if (!known) return `unknown reason code ${code}`;
  return outcome && known !== outcome ? `reason ${code} is ${known}, not ${outcome}` : undefined;
}
