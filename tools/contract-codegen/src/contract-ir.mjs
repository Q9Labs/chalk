// @ts-check

/** @typedef {Record<string, unknown>} JsonObject */

const declarationKinds = new Set(["enum", "error", "object", "opaque", "scalar", "union"]);
const primitiveKinds = new Set(["boolean", "integer", "number", "string"]);
const httpMethods = new Set(["DELETE", "GET", "PATCH", "POST", "PUT"]);
const frameDirections = new Set(["bidirectional", "client-to-server", "server-to-client"]);
const requiredFrameKinds = ["ack", "command", "error", "event", "hello", "ping", "pong", "welcome"];

export class ContractValidationError extends Error {
  /**
   * @param {string[]} issues
   */
  constructor(issues) {
    super(`ContractIR validation failed:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    this.name = "ContractValidationError";
    this.issues = issues;
  }
}

/**
 * @param {unknown} value
 * @returns {value is JsonObject}
 */
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {string[]} issues
 * @returns {JsonObject | undefined}
 */
function objectAt(value, path, issues) {
  if (isObject(value)) {
    return value;
  }
  issues.push(`${path}: expected an object`);
  return undefined;
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {string[]} issues
 * @returns {unknown[] | undefined}
 */
function arrayAt(value, path, issues) {
  if (Array.isArray(value)) {
    return value;
  }
  issues.push(`${path}: expected an array`);
  return undefined;
}

/**
 * @param {JsonObject} object
 * @param {string} key
 * @param {string} path
 * @param {string[]} issues
 * @returns {string | undefined}
 */
function stringAt(object, key, path, issues) {
  const value = object[key];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  issues.push(`${path}.${key}: expected a non-empty string`);
  return undefined;
}

/**
 * @param {JsonObject} object
 * @param {string} key
 * @param {string} path
 * @param {string[]} issues
 * @returns {number | undefined}
 */
function positiveIntegerAt(object, key, path, issues) {
  const value = object[key];
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  issues.push(`${path}.${key}: expected a positive integer`);
  return undefined;
}

/**
 * @param {JsonObject} object
 * @param {string} key
 * @param {string} path
 * @param {string[]} issues
 */
function booleanAt(object, key, path, issues) {
  if (typeof object[key] !== "boolean") {
    issues.push(`${path}.${key}: expected a boolean`);
  }
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {Set<string>} values
 * @param {string} label
 * @param {string[]} issues
 */
function uniqueString(value, path, values, label, issues) {
  if (typeof value !== "string" || value.length === 0) {
    issues.push(`${path}: expected a non-empty ${label}`);
    return;
  }
  if (values.has(value)) {
    issues.push(`${path}: duplicate ${label} "${value}"`);
    return;
  }
  values.add(value);
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {string[]} issues
 */
function validateConstraints(value, path, issues) {
  if (value === undefined) {
    return;
  }
  const constraints = objectAt(value, path, issues);
  if (!constraints) {
    return;
  }
  const allowed = new Set(["format", "maxLength", "maximum", "minLength", "minimum", "pattern"]);
  Object.entries(constraints).forEach(([key, constraint]) => {
    if (!allowed.has(key)) {
      issues.push(`${path}.${key}: unknown constraint`);
      return;
    }
    if (["maxLength", "minLength"].includes(key) && (!Number.isInteger(constraint) || Number(constraint) < 0)) {
      issues.push(`${path}.${key}: expected a non-negative integer`);
    }
    if (["maximum", "minimum"].includes(key) && (typeof constraint !== "number" || !Number.isFinite(constraint))) {
      issues.push(`${path}.${key}: expected a finite number`);
    }
    if (["format", "pattern"].includes(key) && (typeof constraint !== "string" || constraint.length === 0)) {
      issues.push(`${path}.${key}: expected a non-empty string`);
    }
  });
  const minLength = constraints.minLength;
  const maxLength = constraints.maxLength;
  if (typeof minLength === "number" && typeof maxLength === "number" && minLength > maxLength) {
    issues.push(`${path}: minLength cannot exceed maxLength`);
  }
  const minimum = constraints.minimum;
  const maximum = constraints.maximum;
  if (typeof minimum === "number" && typeof maximum === "number" && minimum > maximum) {
    issues.push(`${path}: minimum cannot exceed maximum`);
  }
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {string[]} issues
 */
function validateType(value, path, issues) {
  const type = objectAt(value, path, issues);
  if (!type) {
    return;
  }
  if (typeof type.ref === "string" && type.ref.length > 0 && type.kind === undefined) {
    return;
  }
  const kind = type.kind;
  if (typeof kind !== "string") {
    issues.push(`${path}: expected a declaration ref or supported type kind`);
    return;
  }
  if (primitiveKinds.has(kind)) {
    if (type.literal !== undefined) {
      const literal = type.literal;
      const matches = (kind === "string" && typeof literal === "string") || (kind === "boolean" && typeof literal === "boolean") || (["integer", "number"].includes(kind) && typeof literal === "number" && Number.isFinite(literal));
      if (!matches || (kind === "integer" && !Number.isInteger(literal))) {
        issues.push(`${path}.literal: incompatible with ${kind}`);
      }
    }
    return;
  }
  if (kind === "array") {
    validateType(type.items, `${path}.items`, issues);
    return;
  }
  if (kind === "record") {
    validateType(type.values, `${path}.values`, issues);
    return;
  }
  issues.push(`${path}.kind: unsupported type kind "${kind}"`);
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {string[]} issues
 */
function validateFields(value, path, issues) {
  const fields = arrayAt(value, path, issues);
  const names = new Set();
  fields?.forEach((field, index) => {
    const fieldPath = `${path}[${index}]`;
    const fieldObject = objectAt(field, fieldPath, issues);
    if (!fieldObject) {
      return;
    }
    uniqueString(fieldObject.name, `${fieldPath}.name`, names, "field name", issues);
    validateType(fieldObject.type, `${fieldPath}.type`, issues);
    validateConstraints(fieldObject.constraints, `${fieldPath}.constraints`, issues);
    booleanAt(fieldObject, "optional", fieldPath, issues);
    booleanAt(fieldObject, "nullable", fieldPath, issues);
  });
}

/**
 * @param {JsonObject} declaration
 * @param {string} path
 * @param {string[]} issues
 */
function validateDeclaration(declaration, path, issues) {
  const kind = stringAt(declaration, "kind", path, issues);
  if (!kind || !declarationKinds.has(kind)) {
    if (kind) {
      issues.push(`${path}.kind: unknown declaration kind "${kind}"`);
    }
    return;
  }
  if (kind === "object" || kind === "error") {
    validateFields(declaration.fields, `${path}.fields`, issues);
  }
  if (kind === "scalar") {
    stringAt(declaration, "brand", path, issues);
    if (!primitiveKinds.has(String(declaration.wireType))) {
      issues.push(`${path}.wireType: expected a primitive wire type`);
    }
    validateConstraints(declaration.constraints, `${path}.constraints`, issues);
  }
  if (kind === "enum") {
    const values = arrayAt(declaration.values, `${path}.values`, issues);
    const seen = new Set();
    values?.forEach((value, index) => {
      if ((typeof value !== "string" && typeof value !== "number") || value === "") {
        issues.push(`${path}.values[${index}]: expected a non-empty string or number`);
        return;
      }
      if (seen.has(value)) {
        issues.push(`${path}.values[${index}]: duplicate enum value "${value}"`);
      }
      seen.add(value);
    });
  }
  if (kind === "union") {
    stringAt(declaration, "discriminator", path, issues);
    const variants = arrayAt(declaration.variants, `${path}.variants`, issues);
    const tags = new Set();
    variants?.forEach((variant, index) => {
      const variantPath = `${path}.variants[${index}]`;
      const variantObject = objectAt(variant, variantPath, issues);
      if (!variantObject) {
        return;
      }
      uniqueString(variantObject.tag, `${variantPath}.tag`, tags, "union variant tag", issues);
      validateType(variantObject.type, `${variantPath}.type`, issues);
      if (typeof variantObject.type === "object" && variantObject.type !== null && "ref" in variantObject.type) {
        return;
      }
      issues.push(`${variantPath}.type: union variants must reference declarations`);
    });
  }
  if (kind === "error") {
    stringAt(declaration, "wireCode", path, issues);
    stringAt(declaration, "scope", path, issues);
    const tags = arrayAt(declaration.tags, `${path}.tags`, issues);
    tags?.forEach((tag, index) => {
      if (typeof tag !== "string" || tag.length === 0) {
        issues.push(`${path}.tags[${index}]: expected a non-empty string`);
      }
    });
  }
  if (kind === "opaque" && declaration.encoding !== "json") {
    issues.push(`${path}.encoding: expected "json"`);
  }
}

/**
 * @param {JsonObject} contract
 * @param {string[]} issues
 */
function validateDeclarations(contract, issues) {
  const declarations = arrayAt(contract.declarations, "contract.declarations", issues);
  const ids = new Set();
  declarations?.forEach((declaration, index) => {
    const path = `contract.declarations[${index}]`;
    const declarationObject = objectAt(declaration, path, issues);
    if (!declarationObject) {
      return;
    }
    uniqueString(declarationObject.id, `${path}.id`, ids, "declaration ID", issues);
    validateDeclaration(declarationObject, path, issues);
  });
  return ids;
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {Set<string>} declarationIds
 * @param {string[]} issues
 */
function validateReferences(value, path, declarationIds, issues) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateReferences(item, `${path}[${index}]`, declarationIds, issues));
    return;
  }
  if (!isObject(value)) {
    return;
  }
  Object.entries(value).forEach(([key, child]) => {
    const childPath = `${path}.${key}`;
    if (key === "ref") {
      if (typeof child !== "string" || child.length === 0) {
        issues.push(`${childPath}: expected a non-empty declaration reference`);
      } else if (!declarationIds.has(child)) {
        issues.push(`${childPath}: unknown declaration reference "${child}"`);
      }
    }
    validateReferences(child, childPath, declarationIds, issues);
  });
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {string[]} issues
 */
function validateHeaders(value, path, issues) {
  const headers = arrayAt(value, path, issues);
  const names = new Set();
  headers?.forEach((header, index) => {
    const headerPath = `${path}[${index}]`;
    const headerObject = objectAt(header, headerPath, issues);
    if (!headerObject) {
      return;
    }
    uniqueString(headerObject.name, `${headerPath}.name`, names, "header name", issues);
    validateType(headerObject.type, `${headerPath}.type`, issues);
    booleanAt(headerObject, "optional", headerPath, issues);
  });
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {"errors" | "successes"} category
 * @param {string[]} issues
 */
function validateResponses(value, path, category, issues) {
  const responses = arrayAt(value, path, issues);
  const statuses = new Set();
  responses?.forEach((response, index) => {
    const responsePath = `${path}[${index}]`;
    const responseObject = objectAt(response, responsePath, issues);
    if (!responseObject) {
      return;
    }
    const status = responseObject.status;
    if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) {
      issues.push(`${responsePath}.status: expected an HTTP status code`);
    } else if ((category === "successes" && (status < 200 || status >= 300)) || (category === "errors" && status < 400)) {
      issues.push(`${responsePath}.status: incompatible with ${category}`);
    } else if (statuses.has(status)) {
      issues.push(`${responsePath}.status: duplicate ${category} status ${status}`);
    } else {
      statuses.add(status);
    }
    validateType(responseObject.body, `${responsePath}.body`, issues);
    validateHeaders(responseObject.headers, `${responsePath}.headers`, issues);
  });
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {"path" | "query"} kind
 * @param {string[]} issues
 */
function validateParameters(value, path, kind, issues) {
  const parameters = arrayAt(value, path, issues);
  const names = new Set();
  parameters?.forEach((parameter, index) => {
    const parameterPath = `${path}[${index}]`;
    const parameterObject = objectAt(parameter, parameterPath, issues);
    if (!parameterObject) {
      return;
    }
    uniqueString(parameterObject.name, `${parameterPath}.name`, names, `${kind} parameter name`, issues);
    validateType(parameterObject.type, `${parameterPath}.type`, issues);
    booleanAt(parameterObject, "optional", parameterPath, issues);
    booleanAt(parameterObject, "nullable", parameterPath, issues);
    if (kind === "path" && (parameterObject.optional !== false || parameterObject.nullable !== false)) {
      issues.push(`${parameterPath}: path parameters must be required and non-nullable`);
    }
  });
  return names;
}

/**
 * @param {JsonObject} operation
 * @param {string} path
 * @param {Set<string>} operationIds
 * @param {string[]} issues
 */
function validateOperation(operation, path, operationIds, issues) {
  uniqueString(operation.id, `${path}.id`, operationIds, "operation ID", issues);
  if (typeof operation.method !== "string" || !httpMethods.has(operation.method)) {
    issues.push(`${path}.method: expected a supported uppercase HTTP method`);
  }
  const operationPath = stringAt(operation, "path", path, issues);
  if (operationPath && !operationPath.startsWith("/")) {
    issues.push(`${path}.path: expected an absolute path`);
  }
  const pathNames = validateParameters(operation.pathParameters, `${path}.pathParameters`, "path", issues);
  validateParameters(operation.queryParameters, `${path}.queryParameters`, "query", issues);
  validateHeaders(operation.headers, `${path}.headers`, issues);
  if (operation.body !== undefined) {
    validateType(operation.body, `${path}.body`, issues);
  }
  validateResponses(operation.successes, `${path}.successes`, "successes", issues);
  validateResponses(operation.errors, `${path}.errors`, "errors", issues);
  if (operationPath) {
    const placeholders = new Set([...operationPath.matchAll(/\{([^}]+)\}/gu)].map((match) => match[1]));
    if (placeholders.size !== pathNames.size || [...placeholders].some((name) => !pathNames.has(name)) || [...pathNames].some((name) => !placeholders.has(name))) {
      issues.push(`${path}.pathParameters: must match path placeholders`);
    }
  }
}

/**
 * @param {JsonObject} contract
 * @param {string[]} issues
 */
function validateHttp(contract, issues) {
  const http = objectAt(contract.http, "contract.http", issues);
  if (!http) {
    return;
  }
  const groups = arrayAt(http.groups, "contract.http.groups", issues);
  const groupIds = new Set();
  const operationIds = new Set();
  groups?.forEach((group, index) => {
    const path = `contract.http.groups[${index}]`;
    const groupObject = objectAt(group, path, issues);
    if (!groupObject) {
      return;
    }
    uniqueString(groupObject.id, `${path}.id`, groupIds, "HTTP group ID", issues);
    const basePath = stringAt(groupObject, "basePath", path, issues);
    if (basePath && !basePath.startsWith("/")) {
      issues.push(`${path}.basePath: expected an absolute path`);
    }
    const auth = objectAt(groupObject.auth, `${path}.auth`, issues);
    if (auth) {
      if (auth.kind !== "bearer") {
        issues.push(`${path}.auth.kind: expected "bearer"`);
      }
      const scopes = arrayAt(auth.scopes, `${path}.auth.scopes`, issues);
      scopes?.forEach((scope, scopeIndex) => {
        if (typeof scope !== "string" || scope.length === 0) {
          issues.push(`${path}.auth.scopes[${scopeIndex}]: expected a non-empty string`);
        }
      });
    }
    const rateLimit = objectAt(groupObject.rateLimit, `${path}.rateLimit`, issues);
    if (rateLimit) {
      positiveIntegerAt(rateLimit, "requests", `${path}.rateLimit`, issues);
      positiveIntegerAt(rateLimit, "windowSeconds", `${path}.rateLimit`, issues);
    }
    positiveIntegerAt(groupObject, "bodyLimitBytes", path, issues);
    const operations = arrayAt(groupObject.operations, `${path}.operations`, issues);
    operations?.forEach((operation, operationIndex) => {
      const operationPath = `${path}.operations[${operationIndex}]`;
      const operationObject = objectAt(operation, operationPath, issues);
      if (operationObject) {
        validateOperation(operationObject, operationPath, operationIds, issues);
      }
    });
  });
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {string[]} issues
 */
function validateReferenceType(value, path, issues) {
  const type = objectAt(value, path, issues);
  if (!type || typeof type.ref !== "string" || type.ref.length === 0 || type.kind !== undefined) {
    issues.push(`${path}: expected a declaration reference`);
  }
}

/**
 * @param {JsonObject} sync
 * @param {string[]} issues
 */
function validateSync(sync, issues) {
  if (sync.protocolVersion !== "1") {
    issues.push('contract.sync.protocolVersion: expected "1"');
  }
  const revision = objectAt(sync.revision, "contract.sync.revision", issues);
  if (revision) {
    ["baseField", "cursorPath", "eventField", "stateField", "stream"].forEach((key) => stringAt(revision, key, "contract.sync.revision", issues));
    if (!["exclusive", "inclusive"].includes(String(revision.resume))) {
      issues.push("contract.sync.revision.resume: expected an inclusive or exclusive resume mode");
    }
  }
  const hello = objectAt(sync.hello, "contract.sync.hello", issues);
  if (hello) {
    validateReferenceType(hello.request, "contract.sync.hello.request", issues);
    validateReferenceType(hello.ack, "contract.sync.hello.ack", issues);
  }
  const frames = arrayAt(sync.frames, "contract.sync.frames", issues);
  const frameIds = new Set();
  const frameKinds = new Set();
  frames?.forEach((frame, index) => {
    const path = `contract.sync.frames[${index}]`;
    const frameObject = objectAt(frame, path, issues);
    if (!frameObject) {
      return;
    }
    uniqueString(frameObject.id, `${path}.id`, frameIds, "sync frame ID", issues);
    uniqueString(frameObject.kind, `${path}.kind`, frameKinds, "sync frame kind", issues);
    if (typeof frameObject.direction !== "string" || !frameDirections.has(frameObject.direction)) {
      issues.push(`${path}.direction: expected a supported frame direction`);
    }
    validateReferenceType(frameObject.payload, `${path}.payload`, issues);
  });
  requiredFrameKinds.forEach((kind) => {
    if (!frameKinds.has(kind)) {
      issues.push(`contract.sync.frames: missing ${kind} frame`);
    }
  });
  const messageIds = new Set();
  const commands = arrayAt(sync.commands, "contract.sync.commands", issues);
  commands?.forEach((command, index) => {
    const path = `contract.sync.commands[${index}]`;
    const commandObject = objectAt(command, path, issues);
    if (!commandObject) {
      return;
    }
    uniqueString(commandObject.id, `${path}.id`, messageIds, "sync message ID", issues);
    validateReferenceType(commandObject.payload, `${path}.payload`, issues);
    validateReferenceType(commandObject.ack, `${path}.ack`, issues);
    const errors = arrayAt(commandObject.errors, `${path}.errors`, issues);
    errors?.forEach((error, errorIndex) => validateReferenceType(error, `${path}.errors[${errorIndex}]`, issues));
  });
  const events = arrayAt(sync.events, "contract.sync.events", issues);
  events?.forEach((event, index) => {
    const path = `contract.sync.events[${index}]`;
    const eventObject = objectAt(event, path, issues);
    if (!eventObject) {
      return;
    }
    uniqueString(eventObject.id, `${path}.id`, messageIds, "sync message ID", issues);
    validateReferenceType(eventObject.payload, `${path}.payload`, issues);
  });
  const acks = objectAt(sync.acks, "contract.sync.acks", issues);
  if (acks) {
    validateReferenceType(acks.command, "contract.sync.acks.command", issues);
  }
  ["error", "ping", "pong"].forEach((key) => validateReferenceType(sync[key], `contract.sync.${key}`, issues));
  const closeCodes = arrayAt(sync.closeCodes, "contract.sync.closeCodes", issues);
  const closeIds = new Set();
  const codes = new Set();
  closeCodes?.forEach((closeCode, index) => {
    const path = `contract.sync.closeCodes[${index}]`;
    const closeObject = objectAt(closeCode, path, issues);
    if (!closeObject) {
      return;
    }
    uniqueString(closeObject.id, `${path}.id`, closeIds, "close code ID", issues);
    const code = closeObject.code;
    if (typeof code !== "number" || !Number.isInteger(code) || code < 1000 || code > 4999) {
      issues.push(`${path}.code: expected a WebSocket close code`);
    } else if (codes.has(code)) {
      issues.push(`${path}.code: duplicate WebSocket close code ${code}`);
    } else {
      codes.add(code);
    }
    stringAt(closeObject, "reason", path, issues);
    validateReferenceType(closeObject.error, `${path}.error`, issues);
  });
  const connection = objectAt(sync.connection, "contract.sync.connection", issues);
  if (connection) {
    positiveIntegerAt(connection, "helloTimeoutMs", "contract.sync.connection", issues);
    if (connection.requiredFirstFrame !== "hello") {
      issues.push('contract.sync.connection.requiredFirstFrame: expected "hello"');
    }
    booleanAt(connection, "textFramesOnly", "contract.sync.connection", issues);
    validateReferenceType(connection.protocolErrorFrame, "contract.sync.connection.protocolErrorFrame", issues);
    const reconnectCodes = arrayAt(connection.reconnectOnCloseCodes, "contract.sync.connection.reconnectOnCloseCodes", issues);
    reconnectCodes?.forEach((code, index) => {
      if (typeof code !== "number" || !Number.isInteger(code) || !codes.has(code)) {
        issues.push(`contract.sync.connection.reconnectOnCloseCodes[${index}]: expected a declared close code`);
      }
    });
  }
}

/**
 * @param {JsonObject} contract
 * @param {string[]} issues
 */
function validateSyncRoot(contract, issues) {
  const sync = objectAt(contract.sync, "contract.sync", issues);
  if (sync) {
    validateSync(sync, issues);
  }
}

/**
 * @param {unknown} input
 * @returns {JsonObject}
 */
function validateContract(input) {
  /** @type {string[]} */
  const issues = [];
  const contract = objectAt(input, "contract", issues);
  if (!contract) {
    throw new ContractValidationError(issues);
  }
  if (contract.version !== "1") {
    issues.push('contract.version: expected "1"');
  }
  const declarationIds = validateDeclarations(contract, issues);
  validateHttp(contract, issues);
  validateSyncRoot(contract, issues);
  validateReferences(contract, "contract", declarationIds, issues);
  if (issues.length > 0) {
    throw new ContractValidationError(issues);
  }
  return contract;
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function arraySortKey(value) {
  if (typeof value === "string") {
    return value;
  }
  return isObject(value) ? objectSortKey(value) : undefined;
}

/**
 * @param {JsonObject} value
 */
function objectSortKey(value) {
  const candidate = ["id", "name", "tag", "ref", "code", "status"].map((key) => value[key]).find((item) => typeof item === "string" || typeof item === "number");
  return typeof candidate === "string" || typeof candidate === "number" ? String(candidate) : undefined;
}

/**
 * @param {string} left
 * @param {string} right
 */
function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * @param {unknown[]} values
 * @param {string[]} path
 */
function shouldSortArray(values, path) {
  const key = path.at(-1);
  return ["closeCodes", "commands", "declarations", "errors", "events", "fields", "frames", "groups", "headers", "operations", "pathParameters", "queryParameters", "successes", "tags", "variants"].includes(key ?? "") && values.every((value) => arraySortKey(value) !== undefined);
}

/**
 * @param {unknown} value
 * @param {string[]} path
 * @returns {unknown}
 */
function canonicalValue(value, path) {
  if (Array.isArray(value)) {
    const canonical = value.map((item) => canonicalValue(item, path));
    return shouldSortArray(canonical, path) ? canonical.sort((left, right) => compareStrings(String(arraySortKey(left)), String(arraySortKey(right)))) : canonical;
  }
  if (!isObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([key, child]) => [key, canonicalValue(child, [...path, key])]),
  );
}

/**
 * @param {unknown} input
 * @returns {JsonObject}
 */
export function canonicalizeContract(input) {
  return /** @type {JsonObject} */ (canonicalValue(validateContract(input), []));
}

/**
 * @param {unknown} input
 */
export function canonicalContractJson(input) {
  return `${JSON.stringify(canonicalizeContract(input), null, 2)}\n`;
}
