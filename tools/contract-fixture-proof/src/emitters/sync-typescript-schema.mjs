// Schema source builders shared by the sync TypeScript emitter.
/**
 * @param {Record<string, any>} correlation
 */
function renderCorrelationFields(correlation) {
  return Object.fromEntries(Object.entries(correlation.optionalTopLevelFields).map(([name, field]) => [name, schemaForField({ ...field, optional: true })]));
}

/**
 * @param {Record<string, string>} fields
 * @param {Record<string, string>} correlationFields
 */
export function withCorrelationFields(fields, correlationFields) {
  return { ...fields, ...correlationFields };
}

/**
 * @param {Record<string, any>} field
 */
export function schemaForField(field) {
  let schema;
  switch (field.kind) {
    case "boolean":
      schema = "Schema.Boolean";
      break;
    case "integer":
      schema = `Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(${field.minimum}))`;
      break;
    case "object":
      schema = "Schema.Record(Schema.String, Schema.Unknown)";
      break;
    default:
      schema = "Schema.String";
  }

  if (field.nullable) {
    schema = `Schema.NullOr(${schema})`;
  }
  return field.optional ? `Schema.optional(${schema})` : schema;
}

/**
 * @param {Record<string, string>} fields
 */
export function renderStruct(fields) {
  const entries = Object.entries(fields).map(([name, schema]) => `  ${JSON.stringify(name)}: ${schema}`);
  return `Schema.Struct({\n${entries.join(",\n")}\n})`;
}

/**
 * @param {string[]} schemas
 */
function renderUnion(schemas) {
  return schemas.length === 1 ? schemas[0] : `Schema.Union([${schemas.join(", ")}])`;
}

/**
 * @param {string} value
 */
export function snakeCase(value) {
  return value.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);
}
