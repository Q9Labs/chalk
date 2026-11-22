import { screenAnnotationDefinitions, screenAnnotationV1, type components } from "../generated/screen-annotation-v1";

type Wire = components["schemas"];
type Definition = {
  readonly $ref?: string;
  readonly oneOf?: readonly Definition[];
  readonly enum?: readonly unknown[];
  readonly type?: string;
  readonly properties?: Readonly<Record<string, Definition>>;
  readonly required?: readonly string[];
  readonly items?: Definition;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly format?: string;
  readonly pattern?: string;
};

const definitions: Readonly<Record<string, Definition>> = screenAnnotationDefinitions;
const bytes = new TextEncoder();
const correlation = new Set(["journey_id", "traceparent", "tracestate"]);
const frameDefinitions = new Map<string, Definition>([
  ["annotation_state", screenAnnotationDefinitions.ServerState],
  ["annotation_changed", screenAnnotationDefinitions.ServerChange],
  ["annotation_closed", screenAnnotationDefinitions.ServerClosed],
  ["annotation_receipt", screenAnnotationDefinitions.ServerReceipt],
  ["annotation_presence", screenAnnotationDefinitions.ServerPresence],
]);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const patterns = new Map<string, RegExp>([[screenAnnotationDefinitions.Color.pattern, new RegExp(screenAnnotationDefinitions.Color.pattern)]]);

export function annotationServerFrame(value: unknown, wireBytes: number): Wire["ServerFrame"] | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  const schema = frameDefinitions.get(value.type);
  if (!schema) return null;
  const frame = Object.fromEntries(Object.entries(value).filter(([key]) => !correlation.has(key)));
  const limit = value.type === "annotation_state" ? screenAnnotationV1.limits.stateBytes : screenAnnotationV1.limits.commandBytes;
  if (wireBytes > limit || !matches(frame, schema)) throw new Error("invalid screen annotation frame");
  // The structural schema and this type are generated from the same definitions.
  return frame as Wire["ServerFrame"];
}

export function encodeAnnotationFrame(frame: Wire["ClientFrame"]): string | null {
  const wire = JSON.stringify(frame);
  const limit = frame.type === "annotation_presence" ? screenAnnotationV1.limits.presenceBytes : screenAnnotationV1.limits.commandBytes;
  return bytes.encode(wire).byteLength <= limit && matches(frame, screenAnnotationDefinitions.ClientFrame) ? wire : null;
}

function matches(value: unknown, schema: Definition): boolean {
  if (schema.$ref) {
    const referenced = definitions[schema.$ref.slice("#/$defs/".length)];
    return referenced !== undefined && matches(value, referenced);
  }
  if (schema.oneOf) return schema.oneOf.some((choice) => matches(value, choice));
  if (schema.enum) return schema.enum.includes(value);
  const match = schema.type && primitiveMatchers.get(schema.type);
  return match ? match(value, schema) : false;
}

const primitiveMatchers = new Map<string, (value: unknown, schema: Definition) => boolean>([
  ["null", (value) => value === null],
  ["boolean", (value) => typeof value === "boolean"],
  ["object", matchesObject],
  ["array", matchesArray],
  ["integer", matchesInteger],
  ["string", matchesString],
]);

function matchesObject(value: unknown, schema: Definition): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).length === schema.required?.length &&
    schema.required.every((key) => {
      const property = schema.properties?.[key];
      return !!property && Object.hasOwn(value, key) && matches(value[key], property);
    })
  );
}

function matchesArray(value: unknown, schema: Definition): boolean {
  return Array.isArray(value) && value.length >= (schema.minItems ?? 0) && value.length <= (schema.maxItems ?? 0) && value.every((item: unknown) => !!schema.items && matches(item, schema.items));
}

function matchesInteger(value: unknown, schema: Definition): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= (schema.minimum ?? 0) && value <= (schema.maximum ?? Number.MAX_SAFE_INTEGER);
}

function matchesString(value: unknown, schema: Definition): boolean {
  if (typeof value !== "string") return false;
  if (schema.format === "uuid") return uuid.test(value);
  const length = bytes.encode(value).byteLength;
  return length >= (schema.minLength ?? 0) && length <= (schema.maxLength ?? 0) && (!schema.pattern || patterns.get(schema.pattern)?.test(value) === true);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
