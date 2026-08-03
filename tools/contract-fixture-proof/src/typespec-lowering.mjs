// @ts-check

import { getFormat, getMaxLengthAsNumeric, getMaxValueAsNumeric, getMinLengthAsNumeric, getMinValueAsNumeric, getPattern, getSourceLocation, isArrayModelType, isRecordModelType } from "@typespec/compiler";
import { getAuthentication, getHttpOperation, getRoutePath } from "@typespec/http";
import { getBodyLimit, getCloseCode, getCommandErrors, getOperationId, getRateLimit, getSyncCommand, getSyncConnection, getSyncEvent, getSyncFrame, getSyncHello, getSyncProtocol, getUnionDiscriminator, getWireError, isOpaqueJson } from "./typespec-proof/decorators.mjs";

/** @typedef {import("@typespec/compiler").Interface} Interface */
/** @typedef {import("@typespec/compiler").Model} Model */
/** @typedef {import("@typespec/compiler").ModelProperty} ModelProperty */
/** @typedef {import("@typespec/compiler").Namespace} Namespace */
/** @typedef {import("@typespec/compiler").Program} Program */
/** @typedef {import("@typespec/compiler").Scalar} Scalar */
/** @typedef {import("@typespec/compiler").Type} Type */
/** @typedef {import("@typespec/compiler").Union} Union */

export class TypeSpecLoweringError extends Error {
  /**
   * @param {string} message
   * @param {Type} target
   */
  constructor(message, target) {
    super(message);
    this.name = "TypeSpecLoweringError";
    const location = getSourceLocation(target, { locateId: true });
    const position = location.file.getLineAndCharacterOfPosition(location.pos);
    this.location = `${location.file.path}:${position.line + 1}:${position.character + 1}`;
  }
}

/**
 * @param {string} message
 * @param {Type} target
 * @returns {never}
 */
function failLowering(message, target) {
  throw new TypeSpecLoweringError(message, target);
}

/** @param {Program} program */
function proofNamespace(program) {
  const chalk = program.getGlobalNamespaceType().namespaces.get("Chalk");
  const namespace = chalk?.namespaces.get("ContractProof");
  if (!namespace) {
    throw new Error("TypeSpec fixture must declare namespace Chalk.ContractProof");
  }
  return namespace;
}

/** @param {string} value */
function kebabCase(value) {
  return value
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replaceAll("_", "-")
    .toLowerCase();
}

/**
 * @param {Type} type
 * @param {Namespace} namespace
 */
function referenceFor(type, namespace) {
  if (!("namespace" in type) || type.namespace !== namespace || !("name" in type) || typeof type.name !== "string") {
    return undefined;
  }
  return { ref: `chalk.${type.name}` };
}

/** @param {unknown} value */
function numberValue(value) {
  return typeof value === "number" ? value : value === undefined ? undefined : Number(String(value));
}

/**
 * @param {Program} program
 * @param {Scalar | ModelProperty} target
 */
function constraintsFor(program, target) {
  const constraints = {
    format: getFormat(program, target),
    maxLength: numberValue(getMaxLengthAsNumeric(program, target)),
    maximum: numberValue(getMaxValueAsNumeric(program, target)),
    minLength: numberValue(getMinLengthAsNumeric(program, target)),
    minimum: numberValue(getMinValueAsNumeric(program, target)),
    pattern: getPattern(program, target),
  };
  return Object.fromEntries(Object.entries(constraints).filter(([, value]) => value !== undefined));
}

/** @param {Type} type */
function nullableType(type) {
  if (type.kind !== "Union") {
    return { nullable: false, type };
  }
  const variants = [...type.variants.values()].map((variant) => variant.type);
  const nonNull = variants.filter((variant) => !(variant.kind === "Intrinsic" && variant.name === "null"));
  return nonNull.length === 1 && nonNull[0] !== undefined && nonNull.length !== variants.length ? { nullable: true, type: nonNull[0] } : { nullable: false, type };
}

/**
 * @param {Type} type
 * @param {Namespace} namespace
 * @returns {Record<string, unknown>}
 */
function lowerType(type, namespace) {
  const reference = referenceFor(type, namespace);
  if (reference) {
    return reference;
  }
  if (type.kind === "String") {
    return { kind: "string", literal: type.value };
  }
  if (type.kind === "Number") {
    return { kind: "integer", literal: type.value };
  }
  if (type.kind === "Boolean") {
    return { kind: "boolean", literal: type.value };
  }
  if (type.kind === "Scalar") {
    if (["int8", "int16", "int32", "int64", "integer", "uint8", "uint16", "uint32", "uint64"].includes(type.name)) {
      return { kind: "integer" };
    }
    if (["float", "float32", "float64", "decimal", "decimal128"].includes(type.name)) {
      return { kind: "number" };
    }
    if (type.name === "boolean") {
      return { kind: "boolean" };
    }
    if (type.name === "string") {
      return { kind: "string" };
    }
  }
  if (type.kind === "Model" && isArrayModelType(type)) {
    return { items: lowerType(type.indexer.value, namespace), kind: "array" };
  }
  if (type.kind === "Model" && isRecordModelType(type)) {
    return { kind: "record", values: lowerType(type.indexer.value, namespace) };
  }
  return failLowering(`Unsupported TypeSpec type ${type.kind}; the proof must not widen it to unknown`, type);
}

/**
 * @param {Program} program
 * @param {ModelProperty} property
 * @param {Namespace} namespace
 */
function lowerField(program, property, namespace) {
  const { nullable, type } = nullableType(property.type);
  const constraints = constraintsFor(program, property);
  return {
    ...(Object.keys(constraints).length > 0 ? { constraints } : {}),
    name: property.name,
    nullable,
    optional: property.optional,
    type: lowerType(type, namespace),
  };
}

/** @param {Scalar} scalar */
function scalarWireType(scalar) {
  const baseName = scalar.baseScalar?.name;
  if (["int8", "int16", "int32", "int64", "integer", "uint8", "uint16", "uint32", "uint64"].includes(baseName ?? "")) {
    return "integer";
  }
  if (["float", "float32", "float64", "decimal", "decimal128"].includes(baseName ?? "")) {
    return "number";
  }
  if (baseName === "boolean") {
    return "boolean";
  }
  return "string";
}

/**
 * @param {Program} program
 * @param {Scalar} scalar
 */
function lowerScalar(program, scalar) {
  const constraints = constraintsFor(program, scalar);
  return {
    ...(Object.keys(constraints).length > 0 ? { constraints } : {}),
    brand: kebabCase(scalar.name),
    id: `chalk.${scalar.name}`,
    kind: "scalar",
    wireType: scalarWireType(scalar),
  };
}

/**
 * @param {Program} program
 * @param {Model} model
 * @param {Namespace} namespace
 */
function lowerModel(program, model, namespace) {
  const fields = [...model.properties.values()].map((property) => lowerField(program, property, namespace));
  const error = getWireError(program, model);
  if (error) {
    return { fields, id: `chalk.${model.name}`, kind: "error", ...error };
  }
  if (isOpaqueJson(program, model)) {
    return { encoding: "json", id: `chalk.${model.name}`, kind: "opaque" };
  }
  return { fields, id: `chalk.${model.name}`, kind: "object" };
}

/**
 * @param {Union} union
 * @param {Namespace} namespace
 * @param {Program} program
 */
function lowerUnion(union, namespace, program) {
  const discriminator = getUnionDiscriminator(program, union);
  if (!discriminator) {
    return failLowering(`Union ${union.name ?? "<anonymous>"} is missing an explicit discriminator`, union);
  }
  return {
    discriminator,
    id: `chalk.${union.name}`,
    kind: "union",
    variants: [...union.variants.values()].map((variant) => ({ tag: String(variant.name), type: lowerType(variant.type, namespace) })),
  };
}

/**
 * @param {Program} program
 * @param {Namespace} namespace
 */
function lowerDeclarations(program, namespace) {
  return [
    ...[...namespace.scalars.values()].map((scalar) => lowerScalar(program, scalar)),
    ...[...namespace.models.values()].map((model) => lowerModel(program, model, namespace)),
    ...[...namespace.unions.values()].map((union) => lowerUnion(union, namespace, program)),
    ...[...namespace.enums.values()].map((enumeration) => ({ id: `chalk.${enumeration.name}`, kind: "enum", values: [...enumeration.members.values()].map((member) => member.value ?? member.name) })),
  ];
}

/**
 * @param {import("@typespec/http").HttpOperationResponse} response
 * @param {Namespace} namespace
 */
function lowerResponse(response, namespace) {
  const content = response.responses[0];
  if (!content || !content.body) {
    return failLowering("HTTP response is missing an explicit body", response.type);
  }
  if (typeof response.statusCodes !== "number" || !Number.isInteger(response.statusCodes)) {
    return failLowering("HTTP response must use a concrete numeric status", response.type);
  }
  return {
    body: lowerType(content.body.type, namespace),
    headers: Object.entries(content.headers ?? {}).map(([name, property]) => ({ name, optional: property.optional, type: lowerType(property.type, namespace) })),
    status: response.statusCodes,
  };
}

/**
 * @param {import("@typespec/http").HttpOperationParameter} parameter
 * @param {Namespace} namespace
 */
function lowerParameter(parameter, namespace) {
  const { nullable, type } = nullableType(parameter.param.type);
  return { name: parameter.name, nullable, optional: parameter.param.optional, type: lowerType(type, namespace) };
}

/**
 * @param {Program} program
 * @param {import("@typespec/http").HttpOperation} operation
 * @param {Namespace} namespace
 */
function lowerOperation(program, operation, namespace) {
  const operationId = getOperationId(program, operation.operation);
  if (!operationId) {
    return failLowering(`HTTP operation ${operation.operation.name} is missing @operationId`, operation.operation);
  }
  const successes = operation.responses.filter((response) => typeof response.statusCodes === "number" && response.statusCodes >= 200 && response.statusCodes < 300).map((response) => lowerResponse(response, namespace));
  if (successes.length === 0) {
    return failLowering(`HTTP operation ${operationId} is missing a success response`, operation.operation);
  }
  const errors = operation.responses.filter((response) => typeof response.statusCodes === "number" && response.statusCodes >= 400).map((response) => lowerResponse(response, namespace));
  /** @param {"header" | "path" | "query"} kind */
  const parameters = (kind) => operation.parameters.parameters.filter((parameter) => parameter.type === kind).map((parameter) => lowerParameter(parameter, namespace));
  return {
    ...(operation.parameters.body ? { body: lowerType(operation.parameters.body.type, namespace) } : {}),
    errors,
    headers: parameters("header"),
    id: operationId,
    method: operation.verb.toUpperCase(),
    path: getRoutePath(program, operation.operation)?.path ?? operation.path,
    pathParameters: parameters("path"),
    queryParameters: parameters("query"),
    successes,
  };
}

/**
 * @param {Program} program
 * @param {Interface} interfaceType
 * @param {Namespace} namespace
 */
function lowerHttpGroup(program, interfaceType, namespace) {
  const rateLimit = getRateLimit(program, interfaceType);
  const bodyLimitBytes = getBodyLimit(program, interfaceType);
  if (!rateLimit || !bodyLimitBytes) {
    return failLowering(`HTTP group ${interfaceType.name} is missing rate or body limit metadata`, interfaceType);
  }
  const authentication = getAuthentication(program, interfaceType);
  const scheme = authentication?.options[0]?.schemes[0];
  if (!scheme || scheme.type !== "http" || scheme.scheme !== "Bearer") {
    return failLowering(`HTTP group ${interfaceType.name} must use bearer authentication`, interfaceType);
  }
  const operations = [...interfaceType.operations.values()].map((operation) => {
    const [httpOperation, diagnostics] = getHttpOperation(program, operation);
    const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    if (errors.length > 0) {
      return failLowering(errors.map((diagnostic) => diagnostic.message).join("\n"), operation);
    }
    return lowerOperation(program, httpOperation, namespace);
  });
  return {
    auth: { kind: "bearer", scopes: [] },
    basePath: getRoutePath(program, interfaceType)?.path ?? "/",
    bodyLimitBytes,
    id: kebabCase(interfaceType.name),
    operations,
    rateLimit,
  };
}

/**
 * @param {Type} type
 * @param {Namespace} namespace
 */
function typeReference(type, namespace) {
  const reference = referenceFor(type, namespace);
  return reference ?? failLowering("Sync metadata must reference a named proof declaration", type);
}

/**
 * @param {Program} program
 * @param {Namespace} namespace
 */
function lowerSync(program, namespace) {
  const protocol = getSyncProtocol(program, namespace);
  const connection = getSyncConnection(program, namespace);
  if (!protocol || !connection) {
    throw new Error("Sync protocol is missing @syncProtocol or @syncConnection");
  }
  const models = [...namespace.models.values()];
  const syncTypes = [...models, ...namespace.unions.values()];
  const hello = models.find((model) => getSyncHello(program, model));
  if (!hello) {
    throw new Error("Sync protocol is missing @syncHello");
  }
  const helloMetadata = getSyncHello(program, hello);
  const frames = syncTypes
    .map((type) => ({ metadata: getSyncFrame(program, type), type }))
    .filter((frame) => frame.metadata)
    .map((frame) => ({ direction: frame.metadata.direction, id: `sync.${frame.metadata.kind}`, kind: frame.metadata.kind, payload: typeReference(frame.type, namespace) }));
  /** @param {string} kind */
  const findFrame = (kind) => {
    const frame = frames.find((candidate) => candidate.kind === kind);
    if (!frame) {
      throw new Error(`Sync protocol is missing ${kind} frame`);
    }
    return frame.payload;
  };
  const commands = models
    .map((model) => ({ metadata: getSyncCommand(program, model), model }))
    .filter((command) => command.metadata)
    .map((command) => ({ ack: typeReference(command.metadata.ack, namespace), errors: /** @type {Model[]} */ (getCommandErrors(program, command.model)).map((error) => typeReference(error, namespace)), id: command.metadata.id, payload: typeReference(command.model, namespace) }));
  const events = models
    .map((model) => ({ metadata: getSyncEvent(program, model), model }))
    .filter((event) => event.metadata)
    .map((event) => ({ id: event.metadata.id, payload: typeReference(event.model, namespace) }));
  const closeCodes = models
    .map((model) => ({ metadata: getCloseCode(program, model), model }))
    .filter((entry) => entry.metadata !== undefined)
    .map((entry) => ({ code: entry.metadata.code, error: typeReference(entry.model, namespace), id: kebabCase(entry.model.name), reason: entry.metadata.reason }));
  return {
    acks: { command: findFrame("ack") },
    closeCodes,
    commands,
    connection: {
      helloTimeoutMs: connection.helloTimeoutMs,
      protocolErrorFrame: typeReference(connection.protocolErrorFrame, namespace),
      reconnectOnCloseCodes: [connection.reconnectCloseCode],
      requiredFirstFrame: connection.requiredFirstFrame,
      textFramesOnly: connection.textFramesOnly,
    },
    error: findFrame("error"),
    events,
    frames,
    hello: { ack: typeReference(helloMetadata.ack, namespace), request: typeReference(hello, namespace) },
    ping: findFrame("ping"),
    pong: findFrame("pong"),
    protocolVersion: protocol.version,
    revision: { baseField: protocol.baseField, cursorPath: protocol.cursorPath, eventField: protocol.eventField, resume: protocol.resume, stateField: protocol.stateField, stream: protocol.stream },
  };
}

/** @param {Program} program */
export function lowerTypeSpecProgram(program) {
  const namespace = proofNamespace(program);
  return {
    declarations: lowerDeclarations(program, namespace),
    http: { groups: [...namespace.interfaces.values()].map((interfaceType) => lowerHttpGroup(program, interfaceType, namespace)) },
    sync: lowerSync(program, namespace),
    version: "1",
  };
}
