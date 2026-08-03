import "./tsp-index.mjs";

namespace Chalk.Proof;

using TypeSpec.Reflection;

extern dec rateLimit(target: Interface, requests: valueof integer, windowSeconds: valueof integer);
extern dec bodyLimit(target: Interface, bytes: valueof integer);
extern dec operationId(target: Operation, id: valueof string);
extern dec syncProtocol(
  target: Namespace,
  version: valueof string,
  stream: valueof string,
  cursorPath: valueof string,
  stateField: valueof string,
  eventField: valueof string,
  baseField: valueof string,
  resume: valueof string,
);
extern dec syncHello(target: Model, ack: Model | Union);
extern dec syncConnection(
  target: Namespace,
  helloTimeoutMs: valueof integer,
  requiredFirstFrame: valueof string,
  textFramesOnly: valueof boolean,
  protocolErrorFrame: Model,
  reconnectCloseCode: valueof integer,
);
extern dec syncCommand(target: Model, id: valueof string, ack: Model | Union);
extern dec commandError(target: Model, error: Model);
extern dec syncEvent(target: Model, id: valueof string);
extern dec syncFrame(target: Model | Union, kind: valueof string, direction: valueof string);
extern dec wireError(target: Model, wireCode: valueof string, scope: valueof string, tags: valueof string);
extern dec closeCode(target: Model, code: valueof integer, reason: valueof string);
extern dec opaqueJson(target: Model);
extern dec unionDiscriminator(target: Union, property: valueof string);
