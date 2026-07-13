import { webhookEventSchemaV1 } from "./generated/event-v1.js";

type Schema = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const resolveRef = (ref: string): Schema | undefined => {
  const name = ref.startsWith("#/$defs/") ? ref.slice(8) : "";
  return (webhookEventSchemaV1.$defs as Record<string, Schema>)[name];
};

const typeMatchers: Readonly<Record<string, (value: unknown) => boolean>> = {
  array: Array.isArray,
  integer: Number.isInteger,
  null: (value) => value === null,
  object: isObject,
};

const matchesType = (value: unknown, type: string): boolean => typeMatchers[type]?.(value) ?? typeof value === type;

const hasUniqueItems = (values: readonly unknown[]): boolean => {
  const serialized = values.map((value) => JSON.stringify(value));
  return new Set(serialized).size === serialized.length;
};

const isUtcMillisecondTimestamp = (value: string): boolean => {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
};

const validatesReference = (value: unknown, schema: Schema): boolean | undefined => {
  if (typeof schema.$ref !== "string") return undefined;
  const resolved = resolveRef(schema.$ref);
  return resolved !== undefined && validateSchema(value, resolved);
};

const validatesConstants = (value: unknown, schema: Schema): boolean => {
  if ("const" in schema && !Object.is(value, schema.const)) return false;
  return !Array.isArray(schema.enum) || schema.enum.some((entry) => Object.is(entry, value));
};

const validatesDeclaredType = (value: unknown, schema: Schema): boolean => {
  if (typeof schema.type === "string") return matchesType(value, schema.type);
  return !Array.isArray(schema.type) || schema.type.some((type) => typeof type === "string" && matchesType(value, type));
};

const validatesCompositions = (value: unknown, schema: Schema): boolean => {
  const oneOfMatches = Array.isArray(schema.oneOf) ? schema.oneOf.filter((entry) => isObject(entry) && validateSchema(value, entry)).length : 1;
  if (oneOfMatches !== 1) return false;
  return !Array.isArray(schema.allOf) || schema.allOf.every((entry) => isObject(entry) && validateSchema(value, entry));
};

const validatesPattern = (value: string, schema: Schema): boolean => typeof schema.pattern !== "string" || new RegExp(schema.pattern, "u").test(value);
const validatesFormat = (value: string, schema: Schema): boolean => schema.format !== "date-time" || isUtcMillisecondTimestamp(value);
const validatesMinimumLength = (value: string, schema: Schema): boolean => typeof schema.minLength !== "number" || value.length >= schema.minLength;
const validatesMaximumLength = (value: string, schema: Schema): boolean => typeof schema.maxLength !== "number" || value.length <= schema.maxLength;

const stringValidators = [validatesPattern, validatesFormat, validatesMinimumLength, validatesMaximumLength] as const;
const validatesString = (value: string, schema: Schema): boolean => stringValidators.every((validate) => validate(value, schema));

const validatesMinimumItems = (value: readonly unknown[], schema: Schema): boolean => typeof schema.minItems !== "number" || value.length >= schema.minItems;
const validatesUniqueItems = (value: readonly unknown[], schema: Schema): boolean => schema.uniqueItems !== true || hasUniqueItems(value);
const validatesItems = (value: readonly unknown[], schema: Schema): boolean => !isObject(schema.items) || value.every((entry) => validateSchema(entry, schema.items as Schema));

const arrayValidators = [validatesMinimumItems, validatesUniqueItems, validatesItems] as const;
const validatesArray = (value: readonly unknown[], schema: Schema): boolean => arrayValidators.every((validate) => validate(value, schema));

const validatesRequiredProperties = (value: Record<string, unknown>, schema: Schema): boolean => !Array.isArray(schema.required) || schema.required.every((key) => typeof key === "string" && key in value);

const validatesProperties = (value: Record<string, unknown>, schema: Schema): boolean => {
  if (!isObject(schema.properties)) return true;
  if (!validatesRequiredProperties(value, schema)) return false;
  return Object.entries(schema.properties).every(([key, propertySchema]) => !(key in value) || (isObject(propertySchema) && validateSchema(value[key], propertySchema)));
};

const schemaValidators = [validatesConstants, validatesDeclaredType, validatesCompositions] as const;

const validatesValueConstraints = (value: unknown, schema: Schema): boolean => {
  if (typeof value === "string") return validatesString(value, schema);
  if (Array.isArray(value)) return validatesArray(value, schema);
  if (isObject(value)) return validatesProperties(value, schema);
  return true;
};

export const validateSchema = (value: unknown, schema: Schema): boolean => {
  const referenceResult = validatesReference(value, schema);
  if (referenceResult !== undefined) return referenceResult;
  if (!schemaValidators.every((validate) => validate(value, schema))) return false;
  return validatesValueConstraints(value, schema);
};

export const validateWebhookEnvelopeV1 = (value: unknown): value is Record<string, unknown> => {
  const { oneOf: _oneOf, ...envelopeSchema } = webhookEventSchemaV1;
  return validateSchema(value, envelopeSchema);
};

export const validateKnownWebhookEventV1 = (value: unknown): boolean => validateSchema(value, webhookEventSchemaV1);
