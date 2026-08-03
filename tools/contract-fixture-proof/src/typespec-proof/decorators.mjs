// @ts-check

/** @typedef {import("@typespec/compiler").DecoratorContext} DecoratorContext */
/** @typedef {import("@typespec/compiler").Interface} Interface */
/** @typedef {import("@typespec/compiler").Model} Model */
/** @typedef {import("@typespec/compiler").Namespace} Namespace */
/** @typedef {import("@typespec/compiler").Operation} Operation */
/** @typedef {import("@typespec/compiler").Program} Program */
/** @typedef {import("@typespec/compiler").Type} Type */
/** @typedef {import("@typespec/compiler").Union} Union */

const stateKeys = {
  bodyLimit: Symbol.for("chalk-proof-body-limit"),
  closeCode: Symbol.for("chalk-proof-close-code"),
  command: Symbol.for("chalk-proof-command"),
  commandErrors: Symbol.for("chalk-proof-command-errors"),
  event: Symbol.for("chalk-proof-event"),
  opaqueJson: Symbol.for("chalk-proof-opaque-json"),
  operationId: Symbol.for("chalk-proof-operation-id"),
  rateLimit: Symbol.for("chalk-proof-rate-limit"),
  syncFrame: Symbol.for("chalk-proof-sync-frame"),
  syncHello: Symbol.for("chalk-proof-sync-hello"),
  syncConnection: Symbol.for("chalk-proof-sync-connection"),
  syncProtocol: Symbol.for("chalk-proof-sync-protocol"),
  unionDiscriminator: Symbol.for("chalk-proof-union-discriminator"),
  wireError: Symbol.for("chalk-proof-wire-error"),
};

/**
 * @param {unknown} value
 */
function numberValue(value) {
  return typeof value === "number" ? value : Number(String(value));
}

/**
 * @param {DecoratorContext} context
 * @param {Interface} target
 * @param {unknown} requests
 * @param {unknown} windowSeconds
 */
export function $rateLimit(context, target, requests, windowSeconds) {
  context.program.stateMap(stateKeys.rateLimit).set(target, {
    requests: numberValue(requests),
    windowSeconds: numberValue(windowSeconds),
  });
}

/**
 * @param {DecoratorContext} context
 * @param {Interface} target
 * @param {unknown} bytes
 */
export function $bodyLimit(context, target, bytes) {
  context.program.stateMap(stateKeys.bodyLimit).set(target, numberValue(bytes));
}

/**
 * @param {DecoratorContext} context
 * @param {Operation} target
 * @param {string} id
 */
export function $operationId(context, target, id) {
  context.program.stateMap(stateKeys.operationId).set(target, id);
}

/**
 * @param {DecoratorContext} context
 * @param {Namespace} target
 * @param {string} version
 * @param {string} stream
 * @param {string} cursorPath
 * @param {string} stateField
 * @param {string} eventField
 * @param {string} baseField
 * @param {string} resume
 */
export function $syncProtocol(context, target, version, stream, cursorPath, stateField, eventField, baseField, resume) {
  context.program.stateMap(stateKeys.syncProtocol).set(target, {
    baseField,
    cursorPath,
    eventField,
    resume,
    stateField,
    stream,
    version,
  });
}

/**
 * @param {DecoratorContext} context
 * @param {Model} target
 * @param {Type} ack
 */
export function $syncHello(context, target, ack) {
  context.program.stateMap(stateKeys.syncHello).set(target, { ack });
}

/**
 * @param {DecoratorContext} context
 * @param {Namespace} target
 * @param {unknown} helloTimeoutMs
 * @param {string} requiredFirstFrame
 * @param {boolean} textFramesOnly
 * @param {Model} protocolErrorFrame
 * @param {unknown} reconnectCloseCode
 */
export function $syncConnection(context, target, helloTimeoutMs, requiredFirstFrame, textFramesOnly, protocolErrorFrame, reconnectCloseCode) {
  context.program.stateMap(stateKeys.syncConnection).set(target, {
    helloTimeoutMs: numberValue(helloTimeoutMs),
    protocolErrorFrame,
    reconnectCloseCode: numberValue(reconnectCloseCode),
    requiredFirstFrame,
    textFramesOnly,
  });
}

/**
 * @param {DecoratorContext} context
 * @param {Model} target
 * @param {string} id
 * @param {Type} ack
 */
export function $syncCommand(context, target, id, ack) {
  context.program.stateMap(stateKeys.command).set(target, { ack, id });
}

/**
 * @param {DecoratorContext} context
 * @param {Type} target
 * @param {Model} error
 */
export function $commandError(context, target, error) {
  const errors = context.program.stateMap(stateKeys.commandErrors).get(target) ?? [];
  errors.push(error);
  context.program.stateMap(stateKeys.commandErrors).set(target, errors);
}

/**
 * @param {DecoratorContext} context
 * @param {Model} target
 * @param {string} id
 */
export function $syncEvent(context, target, id) {
  context.program.stateMap(stateKeys.event).set(target, { id });
}

/**
 * @param {DecoratorContext} context
 * @param {Model} target
 * @param {string} kind
 * @param {string} direction
 */
export function $syncFrame(context, target, kind, direction) {
  context.program.stateMap(stateKeys.syncFrame).set(target, { direction, kind });
}

/**
 * @param {DecoratorContext} context
 * @param {Model} target
 * @param {string} wireCode
 * @param {string} scope
 * @param {string} tags
 */
export function $wireError(context, target, wireCode, scope, tags) {
  context.program.stateMap(stateKeys.wireError).set(target, {
    scope,
    tags: tags.split(",").filter(Boolean),
    wireCode,
  });
}

/**
 * @param {DecoratorContext} context
 * @param {Model} target
 * @param {unknown} code
 * @param {string} reason
 */
export function $closeCode(context, target, code, reason) {
  context.program.stateMap(stateKeys.closeCode).set(target, { code: numberValue(code), reason });
}

/**
 * @param {DecoratorContext} context
 * @param {Model} target
 */
export function $opaqueJson(context, target) {
  context.program.stateSet(stateKeys.opaqueJson).add(target);
}

/**
 * @param {DecoratorContext} context
 * @param {Union} target
 * @param {string} property
 */
export function $unionDiscriminator(context, target, property) {
  context.program.stateMap(stateKeys.unionDiscriminator).set(target, property);
}

/** @param {Program} program @param {Interface} target */
export const getRateLimit = (program, target) => program.stateMap(stateKeys.rateLimit).get(target);
/** @param {Program} program @param {Interface} target */
export const getBodyLimit = (program, target) => program.stateMap(stateKeys.bodyLimit).get(target);
/** @param {Program} program @param {Operation} target */
export const getOperationId = (program, target) => program.stateMap(stateKeys.operationId).get(target);
/** @param {Program} program @param {Namespace} target */
export const getSyncProtocol = (program, target) => program.stateMap(stateKeys.syncProtocol).get(target);
/** @param {Program} program @param {Type} target */
export const getSyncHello = (program, target) => program.stateMap(stateKeys.syncHello).get(target);
/** @param {Program} program @param {Namespace} target */
export const getSyncConnection = (program, target) => program.stateMap(stateKeys.syncConnection).get(target);
/** @param {Program} program @param {Type} target */
export const getSyncCommand = (program, target) => program.stateMap(stateKeys.command).get(target);
/** @param {Program} program @param {Model} target */
export const getCommandErrors = (program, target) => program.stateMap(stateKeys.commandErrors).get(target) ?? [];
/** @param {Program} program @param {Model} target */
export const getSyncEvent = (program, target) => program.stateMap(stateKeys.event).get(target);
/** @param {Program} program @param {Type} target */
export const getSyncFrame = (program, target) => program.stateMap(stateKeys.syncFrame).get(target);
/** @param {Program} program @param {Model} target */
export const getWireError = (program, target) => program.stateMap(stateKeys.wireError).get(target);
/** @param {Program} program @param {Type} target */
export const getCloseCode = (program, target) => program.stateMap(stateKeys.closeCode).get(target);
/** @param {Program} program @param {Model} target */
export const isOpaqueJson = (program, target) => program.stateSet(stateKeys.opaqueJson).has(target);
/** @param {Program} program @param {Union} target */
export const getUnionDiscriminator = (program, target) => program.stateMap(stateKeys.unionDiscriminator).get(target);
