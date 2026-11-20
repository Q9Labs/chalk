import { randomUUID } from "node:crypto";
import {
  ENVIRONMENTS,
  EVENTS,
  FIELDS,
  MACHINES,
  MODULES,
  REASONS,
  SCHEMA_VER,
  type Environment,
  type Kind,
  type Module,
  type Outcome,
  type Platform,
} from "./registry.js";

// The Node half of the observability kernel: the same five calls and the same record shape as the Go kernel
// (apps/api/internal/obs/kernel.go) and the client kernel (sdks/typescript/client/src/obs/kernel.ts), checked
// against the generated registry in ./registry.ts. The dispatcher's sink is its JSON-line logger, which the
// local-run harness and the Lambda delivery layer each turn into the `lambda` evidence source.

// The dispatcher's records are flat JSON lines, so unlike the client kernel this one admits only scalar fields.
export type RecordValue = string | number | boolean;
export type ObsRecord = { readonly kind: Kind; readonly name: string; readonly event_id: string; readonly [field: string]: RecordValue };
export type Classification = { readonly outcome: "expected"; readonly code: string } | { readonly outcome: "error"; readonly code: string };
export type KernelMode = "open" | "closed";

export class ClassifiedError extends Error {
  readonly classification: Classification;
  constructor(classification: Classification, cause?: unknown) {
    super(`${classification.outcome}(${classification.code})`, { cause });
    this.name = "ClassifiedError";
    this.classification = classification;
  }
}

export const expected = (code: string, cause?: unknown) => new ClassifiedError({ outcome: "expected", code }, cause);
export const failure = (code: string, cause?: unknown) => new ClassifiedError({ outcome: "error", code }, cause);

export class ObsViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObsViolation";
  }
}

export type KernelOptions = {
  readonly sink: (record: ObsRecord) => void;
  readonly build: { readonly module: Module; readonly env: Environment; readonly platform?: Platform; readonly release_sha?: string };
  readonly mode: KernelMode;
  readonly trail?: () => Record<string, RecordValue>;
  readonly sourceId?: string;
  readonly uuid?: () => string;
  readonly now?: () => number;
};

export type OpScope = {
  readonly opId: string;
  expected(code: string): void;
  set(fields: Record<string, RecordValue | undefined>): void;
};

export type OpOptions = {
  readonly parentOpId?: string;
  readonly classify?: (error: unknown) => Classification | undefined;
};

export type Kernel = {
  op<T>(name: string, fields: Record<string, RecordValue | undefined>, run: (scope: OpScope) => T | Promise<T>, options?: OpOptions): Promise<T>;
  transition(machine: string, from: string, to: string, trigger: string, fields?: Record<string, RecordValue | undefined>, options?: { reason?: string; durationMs?: number }): void;
  decision(name: string, decision: string, fields?: Record<string, RecordValue | undefined>, reason?: string): string;
  fact(name: string, fields?: Record<string, RecordValue | undefined>): void;
  surface(name: string, fields?: Record<string, RecordValue | undefined>): { dismiss(): void };
  stats(): { records: number; violations: number; exportFailures: number; lastViolation?: string };
};

type FieldRule = { readonly required: boolean; readonly values?: readonly string[] };
type EventSpec = { readonly kind: Kind; readonly decisions: readonly string[]; readonly fields: { readonly [name: string]: FieldRule } };
type MachineSpec = { readonly states: readonly string[]; readonly edges: readonly (readonly string[])[]; readonly triggers: readonly string[] };

const EVENT_SPECS: ReadonlyMap<string, EventSpec> = new Map(Object.entries(EVENTS));
const FIELD_SPECS = new Map(Object.entries(FIELDS));
const MACHINE_SPECS: ReadonlyMap<string, MachineSpec> = new Map(Object.entries(MACHINES));
const REASON_SPECS: ReadonlyMap<string, Outcome> = new Map(Object.entries(REASONS));

const isRecordValue = (value: unknown): value is RecordValue => typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));

const isAbortError = (error: unknown): boolean => typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
const unwrapped = (error: unknown) => (error instanceof ClassifiedError && error.cause !== undefined ? error.cause : error);
const defined = <T>(value: T | undefined): value is T => value !== undefined;

const FITS: { readonly [type: string]: (value: unknown, allowed: readonly string[]) => boolean } = {
  enum: (value, allowed) => typeof value === "string" && allowed.includes(value),
  int: (value) => typeof value === "number" && Number.isSafeInteger(value),
  number: (value) => typeof value === "number" && Number.isFinite(value),
  bool: (value) => typeof value === "boolean",
  string: (value) => typeof value === "string" && value.length > 0,
  id: (value) => typeof value === "string" && value.length > 0,
  map: isRecordValue,
};

function fieldProblem(name: string, field: string, value: unknown, rules: { readonly [name: string]: FieldRule }): string | undefined {
  const spec = FIELD_SPECS.get(field);
  if (!spec) return `${name}: field ${field} is not in the registry`;
  const rule = rules[field];
  if (!rule && spec.group !== "trail") return `${name}: field ${field} is not declared on this event`;
  const allowed = rule?.values ?? ("values" in spec ? (spec.values as readonly string[]) : []);
  if (FITS[spec.type]?.(value, allowed) === true) return undefined;
  return `${name}: field ${field} has ${JSON.stringify(value)}, which is not a valid ${spec.type}${spec.type === "enum" ? ` (${allowed.join(", ")})` : ""}`;
}

function fieldProblems(name: string, fields: object, rules: { readonly [name: string]: FieldRule }): string[] {
  const given = Object.entries(fields).filter(([, value]) => value !== undefined);
  const supplied = new Set(given.map(([field]) => field));
  return [
    ...given.map(([field, value]) => fieldProblem(name, field, value, rules)).filter(defined),
    ...Object.entries(rules)
      .filter(([field, rule]) => rule.required && !supplied.has(field))
      .map(([field]) => `${name}: required field ${field} is missing`),
  ];
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
  return outcome !== undefined && known !== outcome ? `reason ${code} is ${known}, not ${outcome}` : undefined;
}

/** The reason code a dispatcher error code maps to: `transcript.<code>` when the registry declares it, else the generic failure. */
export function errorReason(errorCode: string): string {
  const code = `transcript.${errorCode}`;
  return REASON_SPECS.has(code) && REASON_SPECS.get(code) === "error" ? code : "transcript.unknown_failure";
}

export function createKernel(options: KernelOptions): Kernel {
  const uuid = options.uuid ?? (() => randomUUID());
  const now = options.now ?? Date.now;
  const sourceId = options.sourceId ?? uuid();
  let seq = 0;
  let records = 0;
  let violations = 0;
  let exportFailures = 0;
  let lastViolation: string | undefined;

  if (!MODULES.includes(options.build.module)) throw new ObsViolation(`obs: ${options.build.module} is not a registry module`);
  if (!ENVIRONMENTS.includes(options.build.env)) throw new ObsViolation(`obs: ${options.build.env} is not a registry env`);

  const violate = (problems: readonly string[]) => {
    if (problems.length === 0) return;
    const message = problems.join("; ");
    if (options.mode === "closed") throw new ObsViolation(message);
    violations += problems.length;
    lastViolation = message;
  };

  const put = (record: { [field: string]: RecordValue }, fields: object) => {
    for (const [field, value] of Object.entries(fields)) if (value !== undefined && isRecordValue(value)) record[field] = value;
  };

  function send(kind: Kind, name: string, fields: object, own: object, failed = false): void {
    const record: { [field: string]: RecordValue } = {};
    put(record, options.trail?.() ?? {});
    put(record, fields);
    put(record, options.build);
    put(record, { schema_ver: SCHEMA_VER, source_id: sourceId, seq: ++seq, clock_state: "server", est_server_ms: Math.round(now()), platform: options.build.platform ?? "lambda" });
    put(record, own);
    const stamped: ObsRecord = { ...record, kind, name, event_id: uuid() };
    records += 1;
    try {
      options.sink(stamped);
    } catch (error) {
      if (options.mode === "closed") throw error;
      exportFailures += 1;
    }
    void failed;
  }

  const classify = (error: unknown, custom: OpOptions["classify"]): Classification => {
    if (error instanceof ClassifiedError) return error.classification;
    const named = custom?.(error);
    if (named !== undefined) return named;
    return isAbortError(error) ? { outcome: "expected", code: "cancelled" } : { outcome: "error", code: "unclassified" };
  };

  return {
    async op(name, fields, run, opOptions) {
      violate(eventProblems(name, "op", fields));
      const opId = uuid();
      const started = Date.now();
      let expectedCode: string | undefined;
      let extra: Record<string, RecordValue | undefined> = {};
      const scope: OpScope = {
        opId,
        expected: (code) => {
          expectedCode = code;
        },
        set: (more) => {
          extra = { ...extra, ...more };
        },
      };
      let classification: Classification | undefined;
      try {
        const value = await run(scope);
        if (expectedCode !== undefined) classification = { outcome: "expected", code: expectedCode };
        return value;
      } catch (error) {
        classification = classify(error, opOptions?.classify);
        throw unwrapped(error);
      } finally {
        const merged = { ...fields, ...extra };
        violate([...fieldProblems(name, merged, EVENT_SPECS.get(name)?.fields ?? {}), ...[reasonProblem(classification?.code, classification?.outcome)].filter(defined)]);
        send("op", name, merged, {
          outcome: classification?.outcome ?? "ok",
          ...(classification?.code === undefined ? {} : { reason_code: classification.code }),
          duration_ms: Date.now() - started,
          op_id: opId,
          ...(opOptions?.parentOpId === undefined ? {} : { parent_op_id: opOptions.parentOpId }),
        }, classification?.outcome === "error");
      }
    },

    transition(machine, from, to, trigger, fields = {}, transitionOptions) {
      const spec = MACHINE_SPECS.get(machine);
      const problems = fieldProblems(machine, fields, {});
      if (!spec) problems.push(`unknown machine ${machine}`);
      else {
        if (!spec.edges.some(([edgeFrom, edgeTo]) => edgeFrom === from && edgeTo === to)) problems.push(`${machine}: ${from} -> ${to} is not a declared edge`);
        if (!spec.triggers.includes(trigger)) problems.push(`${machine}: unknown trigger ${trigger}`);
      }
      const reason = reasonProblem(transitionOptions?.reason);
      if (reason !== undefined) problems.push(`${machine}: ${reason}`);
      violate(problems);
      send("transition", machine, fields, {
        machine,
        from_state: from,
        to_state: to,
        trigger,
        ...(transitionOptions?.reason === undefined ? {} : { reason_code: transitionOptions.reason }),
        ...(transitionOptions?.durationMs === undefined ? {} : { duration_ms: transitionOptions.durationMs }),
      });
    },

    decision(name, decision, fields = {}, reason) {
      const problems = eventProblems(name, "decision", fields);
      if (!EVENT_SPECS.get(name)?.decisions.includes(decision)) problems.push(`${name}: unknown decision ${decision}`);
      const reasonIssue = reasonProblem(reason);
      if (reasonIssue !== undefined) problems.push(`${name}: ${reasonIssue}`);
      violate(problems);
      const decisionId = uuid();
      send("decision", name, fields, { decision, decision_id: decisionId, ...(reason === undefined ? {} : { reason_code: reason }) });
      return decisionId;
    },

    fact(name, fields = {}) {
      violate(eventProblems(name, "fact", fields));
      send("fact", name, fields, {});
    },

    surface(name, fields = {}) {
      violate(eventProblems(name, "surface", fields));
      const shownAt = Date.now();
      let dismissed = false;
      send("surface", name, fields, { surface_state: "shown" });
      return {
        dismiss() {
          if (dismissed) return;
          dismissed = true;
          send("surface", name, fields, { surface_state: "dismissed", shown_ms: Date.now() - shownAt });
        },
      };
    },

    stats: () => ({ records, violations, exportFailures, ...(lastViolation === undefined ? {} : { lastViolation }) }),
  };
}
