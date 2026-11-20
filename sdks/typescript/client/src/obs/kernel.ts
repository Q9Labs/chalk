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

function valueProblem(field: string, value: unknown, spec: FieldSpec, allowed: readonly string[] | undefined): string | undefined {
  const fits = {
    enum: typeof value === "string" && (allowed ?? []).includes(value),
    int: typeof value === "number" && Number.isSafeInteger(value),
    number: typeof value === "number" && Number.isFinite(value),
    bool: typeof value === "boolean",
    string: typeof value === "string" && value.length > 0,
    id: typeof value === "string" && value.length > 0,
    map: isFlagMap(value),
  }[spec.type];
  return fits ? undefined : `field ${field} has ${JSON.stringify(value)}, which is not a valid ${spec.type}${spec.type === "enum" ? ` (${(allowed ?? []).join(", ")})` : ""}`;
}

// Checks caller-supplied fields: trail fields anywhere, event fields only on their event.
function fieldProblems(name: string, fields: object, rules: { readonly [name: string]: FieldRule }): string[] {
  const problems: string[] = [];
  for (const [field, value] of entriesOf(fields)) {
    if (value === undefined) continue;
    const spec = FIELD_SPECS.get(field);
    const rule = rules[field];
    if (!spec) problems.push(`${name}: field ${field} is not in the registry`);
    else if (!rule && spec.group !== "trail") problems.push(`${name}: field ${field} is not declared on this event`);
    else {
      const problem = valueProblem(field, value, spec, rule?.values ?? spec.values);
      if (problem) problems.push(`${name}: ${problem}`);
    }
  }
  for (const [field, rule] of Object.entries(rules)) if (rule.required && entriesOf(fields).every(([key, value]) => key !== field || value === undefined)) problems.push(`${name}: required field ${field} is missing`);
  return problems;
}

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

  const kernel: Kernel = {
    async op(name, fields, run, opOptions) {
      violate(eventProblems(name, "op", fields));
      const opId = uuid();
      const started = performance.now();
      let extra: object = {};
      let expectedCode: ExpectedReason | undefined;
      let classification: Classification | undefined;
      inFlight.set(opId, { name, op_id: opId, started_ms: Math.round(now()) });
      const scope: OpScope<typeof name> = {
        opId,
        expected: (code) => {
          expectedCode = code;
        },
        set: (more) => {
          extra = { ...extra, ...more };
        },
      };
      try {
        const value = await run(scope);
        if (expectedCode !== undefined) classification = { outcome: "expected", code: expectedCode };
        return value;
      } catch (error) {
        classification = classify(error, opOptions?.classify);
        throw error instanceof ClassifiedError && error.cause !== undefined ? error.cause : error;
      } finally {
        inFlight.delete(opId);
        const outcome = classification?.outcome ?? "ok";
        violate([...(Object.keys(extra).length > 0 ? eventProblems(name, "op", { ...fields, ...extra }) : []), reasonProblem(classification?.code, outcome)].filter((problem) => problem !== undefined));
        send("op", name, { ...fields, ...extra, attempt: opOptions?.attempt }, { outcome, reason_code: classification?.code, duration_ms: Math.round(performance.now() - started), op_id: opId, parent_op_id: opOptions?.parentOpId });
      }
    },

    transition(machine, from, to, trigger, fields = {}, transitionOptions) {
      const spec = MACHINE_SPECS.get(machine);
      const problems = spec ? fieldProblems(machine, fields, {}) : [`unknown machine ${machine}`];
      if (spec && !spec.edges.some(([edgeFrom, edgeTo]) => edgeFrom === from && edgeTo === to)) problems.push(`${machine}: ${from} -> ${to} is not a declared edge`);
      if (spec && !spec.triggers.includes(trigger)) problems.push(`${machine}: unknown trigger ${trigger}`);
      const reason = reasonProblem(transitionOptions?.reason);
      if (reason) problems.push(`${machine}: ${reason}`);
      violate(problems);
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
