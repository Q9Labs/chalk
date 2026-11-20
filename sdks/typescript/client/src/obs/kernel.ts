import type { ClockEstimator } from "./clock.ts";
import { flagsHash } from "./flags.ts";
import {
  EVENTS,
  FIELDS,
  MACHINES,
  REASONS,
  SCHEMA_VER,
  type DecisionName,
  type DecisionValue,
  type Environment,
  type ErrorReason,
  type EventFields,
  type ExpectedReason,
  type FactName,
  type FlagMap,
  type FlagValue,
  type Kind,
  type MachineName,
  type MachineState,
  type MachineTrigger,
  type Module,
  type OpName,
  type Outcome,
  type Platform,
  type ReasonCode,
  type SurfaceName,
  type Trail,
} from "./registry.ts";

// The five kernel calls. Every record is checked against the generated registry: in "closed" mode (tests and CI)
// a violation throws, and in "open" mode (production) it is counted and the record still goes out.

export type KernelMode = "open" | "closed";
export type RecordValue = string | number | boolean | FlagMap;
export type ObsRecord = { readonly kind: Kind; readonly name: string; readonly event_id: string; readonly seq: number; readonly [field: string]: RecordValue };

export type Classification = { readonly outcome: "expected"; readonly code: ExpectedReason } | { readonly outcome: "error"; readonly code: ErrorReason };

// Thrown inside an op to name its outcome. The op records the classification and rethrows the cause.
export class ClassifiedError extends Error {
  readonly classification: Classification;
  constructor(classification: Classification, cause?: unknown) {
    super(`${classification.outcome}(${classification.code})`, { cause });
    this.name = "ClassifiedError";
    this.classification = classification;
  }
}

export const expected = (code: ExpectedReason, cause?: unknown) => new ClassifiedError({ outcome: "expected", code }, cause);
export const failure = (code: ErrorReason, cause?: unknown) => new ClassifiedError({ outcome: "error", code }, cause);

export class ObsViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObsViolation";
  }
}

export type BuildInfo = {
  readonly module: Module;
  readonly env: Environment;
  readonly platform?: Platform;
  readonly release_sha?: string;
  readonly app_version?: string;
  readonly app_build?: string;
  readonly sdk_version?: string;
};

export type KernelOptions = {
  readonly sink: (record: ObsRecord) => void;
  readonly build: BuildInfo;
  // Owns seq. A client passes its client session id; a server passes its instance id.
  readonly sourceId: string;
  readonly mode: KernelMode;
  // Clients pass their estimator. Without one the kernel stamps its own clock as a server clock.
  readonly clock?: ClockEstimator;
  readonly trail?: () => Trail;
  readonly flags?: FlagMap;
  readonly uuid?: () => string;
  readonly now?: () => number;
};

export type OpScope<N extends OpName> = {
  readonly opId: string;
  // Ends the op as expected(code) when it returns normally, such as a join that found the Episode already ended.
  expected(code: ExpectedReason): void;
  set(fields: Partial<EventFields[N]>): void;
};

export type OpOptions = {
  readonly parentOpId?: string;
  readonly attempt?: number;
  // Names errors the op knows. Anything it returns undefined for, and isn't an AbortError, is error(unclassified).
  readonly classify?: (error: unknown) => Classification | undefined;
};

export type TransitionOptions = { readonly reason?: ReasonCode; readonly durationMs?: number };
export type SurfaceHandle = { dismiss(): void };
export type InFlightOp = { readonly name: OpName; readonly op_id: string; readonly started_ms: number };
export type KernelStats = { readonly records: number; readonly violations: number; readonly exportFailures: number; readonly lastViolation?: string };

export type Kernel = {
  op<N extends OpName, T>(name: N, fields: EventFields[N], run: (scope: OpScope<N>) => T | Promise<T>, options?: OpOptions): Promise<T>;
  transition<M extends MachineName>(machine: M, from: MachineState<M>, to: MachineState<M>, trigger: MachineTrigger<M>, fields?: Trail, options?: TransitionOptions): void;
  decision<N extends DecisionName>(name: N, decision: DecisionValue<N>, fields: EventFields[N], reason?: ReasonCode): string;
  surface<N extends SurfaceName>(name: N, fields: EventFields[N]): SurfaceHandle;
  fact<N extends FactName>(name: N, fields: EventFields[N]): void;
  setFlags(flags: FlagMap): void;
  inFlight(): readonly InFlightOp[];
  stats(): KernelStats;
};

type FieldRule = { readonly required: boolean; readonly values?: readonly string[] };
type EventSpec = { readonly kind: Kind; readonly decisions: readonly string[]; readonly fields: { readonly [name: string]: FieldRule } };
type FieldSpec = { readonly type: string; readonly group: string; readonly values?: readonly string[] };
type MachineSpec = { readonly states: readonly string[]; readonly edges: readonly (readonly string[])[]; readonly triggers: readonly string[] };

const EVENT_SPECS: ReadonlyMap<string, EventSpec> = new Map(Object.entries(EVENTS));
const FIELD_SPECS: ReadonlyMap<string, FieldSpec> = new Map(Object.entries(FIELDS));
const MACHINE_SPECS: ReadonlyMap<string, MachineSpec> = new Map(Object.entries(MACHINES));
const REASON_SPECS: ReadonlyMap<string, Outcome> = new Map(Object.entries(REASONS));

const entriesOf = (value: object): [string, unknown][] => Object.entries(value);

const isFlagValue = (value: unknown): value is FlagValue => value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));

function isFlagMap(value: unknown): value is FlagMap {
  return typeof value === "object" && value !== null && !Array.isArray(value) && entriesOf(value).every(([, member]) => isFlagValue(member));
}

function isRecordValue(value: unknown): value is RecordValue {
  return typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) || isFlagMap(value);
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

const isDefined = <T>(value: T | undefined): value is T => value !== undefined;

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

function machineProblems(machine: string, from: string, to: string, trigger: string, fields: object): string[] {
  const spec = MACHINE_SPECS.get(machine);
  if (!spec) return [`unknown machine ${machine}`];
  const problems = fieldProblems(machine, fields, {});
  if (!spec.edges.some(([edgeFrom, edgeTo]) => edgeFrom === from && edgeTo === to)) problems.push(`${machine}: ${from} -> ${to} is not a declared edge`);
  if (!spec.triggers.includes(trigger)) problems.push(`${machine}: unknown trigger ${trigger}`);
  return problems;
}

const unwrapped = (error: unknown) => (error instanceof ClassifiedError && error.cause !== undefined ? error.cause : error);

type OpState = { extra: object; expectedCode?: ExpectedReason; classification?: Classification };

function eventProblems(name: string, kind: Kind, fields: object): string[] {
  const spec = EVENT_SPECS.get(name);
  if (!spec) return [`unknown event ${name}`];
  if (spec.kind !== kind) return [`${name} is a ${spec.kind}, not a ${kind}`];
  return fieldProblems(name, fields, spec.fields);
}

function reasonProblem(code: string | undefined, outcome?: Outcome): string | undefined {
  if (code === undefined) return undefined;
  const known = REASON_SPECS.get(code);
  if (!known) return `unknown reason code ${code}`;
  return outcome && known !== outcome ? `reason ${code} is ${known}, not ${outcome}` : undefined;
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

export function createKernel(options: KernelOptions): Kernel {
  const uuid = options.uuid ?? (() => crypto.randomUUID());
  const now = options.now ?? Date.now;
  const inFlight = new Map<string, InFlightOp>();
  let seq = 0;
  let records = 0;
  let violations = 0;
  let exportFailures = 0;
  let lastViolation: string | undefined;
  let currentFlagsHash: string | undefined;

  const violate = (problems: readonly string[]) => {
    if (problems.length === 0) return;
    const message = problems.join("; ");
    if (options.mode === "closed") throw new ObsViolation(message);
    violations += problems.length;
    lastViolation = message;
  };

  const put = (record: { [field: string]: RecordValue }, fields: object) => {
    for (const [field, value] of entriesOf(fields)) if (isRecordValue(value)) record[field] = value;
  };

  const clockFields = (): object => {
    if (!options.clock) return { clock_state: "server", est_server_ms: Math.round(now()) };
    const jump = options.clock.detectJump();
    if (jump !== undefined) send("fact", "obs.clock_jump", { jump_ms: jump }, {});
    return options.clock.stamp();
  };

  function send(kind: Kind, name: string, fields: object, own: object): void {
    // Stamp the clock first: a detected jump records its own fact, which must take the earlier seq.
    const clock = clockFields();
    seq += 1;
    const record: { [field: string]: RecordValue } = {};
    put(record, options.trail?.() ?? {});
    put(record, fields);
    put(record, options.build);
    put(record, clock);
    const eventId = uuid();
    put(record, { source_id: options.sourceId, schema_ver: SCHEMA_VER, flags_hash: currentFlagsHash });
    put(record, own);
    const stamped: ObsRecord = { ...record, kind, name, event_id: eventId, seq };
    records += 1;
    try {
      options.sink(stamped);
    } catch (error) {
      if (options.mode === "closed") throw error;
      exportFailures += 1;
    }
  }

  const classify = (error: unknown, custom: OpOptions["classify"]): Classification => {
    if (error instanceof ClassifiedError) return error.classification;
    const named = custom?.(error);
    if (named) return named;
    return isAbortError(error) ? { outcome: "expected", code: "cancelled" } : { outcome: "error", code: "unclassified" };
  };

  // Records the op's one terminal outcome, checking any fields it learned while it ran.
  const finishOp = (name: string, fields: object, state: OpState, run: { readonly opId: string; readonly started: number; readonly options: OpOptions | undefined }) => {
    const outcome = state.classification?.outcome ?? "ok";
    const code = state.classification?.code;
    const late = Object.keys(state.extra).length > 0 ? eventProblems(name, "op", { ...fields, ...state.extra }) : [];
    violate([...late, reasonProblem(code, outcome)].filter(isDefined));
    send("op", name, { ...fields, ...state.extra, attempt: run.options?.attempt }, { outcome, reason_code: code, duration_ms: Math.round(performance.now() - run.started), op_id: run.opId, parent_op_id: run.options?.parentOpId });
  };

  const kernel: Kernel = {
    async op(name, fields, run, opOptions) {
      violate(eventProblems(name, "op", fields));
      const opId = uuid();
      const started = performance.now();
      const state: OpState = { extra: {} };
      inFlight.set(opId, { name, op_id: opId, started_ms: Math.round(now()) });
      const scope: OpScope<typeof name> = {
        opId,
        expected: (code) => {
          state.expectedCode = code;
        },
        set: (more) => {
          state.extra = { ...state.extra, ...more };
        },
      };
      try {
        const value = await run(scope);
        if (state.expectedCode !== undefined) state.classification = { outcome: "expected", code: state.expectedCode };
        return value;
      } catch (error) {
        state.classification = classify(error, opOptions?.classify);
        throw unwrapped(error);
      } finally {
        inFlight.delete(opId);
        finishOp(name, fields, state, { opId, started, options: opOptions });
      }
    },

    transition(machine, from, to, trigger, fields = {}, transitionOptions) {
      const reason = reasonProblem(transitionOptions?.reason);
      violate([...machineProblems(machine, from, to, trigger, fields), ...(reason === undefined ? [] : [`${machine}: ${reason}`])]);
      send("transition", machine, fields, { machine, from_state: from, to_state: to, trigger, reason_code: transitionOptions?.reason, duration_ms: transitionOptions?.durationMs });
    },

    decision(name, decision, fields, reason) {
      const problems = eventProblems(name, "decision", fields);
      if (!EVENT_SPECS.get(name)?.decisions.includes(decision)) problems.push(`${name}: unknown decision ${decision}`);
      const reasonIssue = reasonProblem(reason);
      if (reasonIssue) problems.push(`${name}: ${reasonIssue}`);
      violate(problems);
      const decisionId = uuid();
      send("decision", name, fields, { decision, decision_id: decisionId, reason_code: reason });
      return decisionId;
    },

    surface(name, fields) {
      violate(eventProblems(name, "surface", fields));
      const shownAt = performance.now();
      let dismissed = false;
      send("surface", name, fields, { surface_state: "shown" });
      return {
        dismiss() {
          if (dismissed) return;
          dismissed = true;
          send("surface", name, fields, { surface_state: "dismissed", shown_ms: Math.round(performance.now() - shownAt) });
        },
      };
    },

    fact(name, fields) {
      violate(eventProblems(name, "fact", fields));
      send("fact", name, fields, {});
    },

    setFlags(flags) {
      currentFlagsHash = flagsHash(flags);
      send("fact", "obs.flags_snapshot", { flags }, {});
    },

    inFlight: () => [...inFlight.values()],
    stats: () => ({ records, violations, exportFailures, ...(lastViolation === undefined ? {} : { lastViolation }) }),
  };

  if (options.flags) kernel.setFlags(options.flags);
  return kernel;
}
