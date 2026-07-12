import type { ClientFrame, ServerFrame } from "./types";

export type SyncProtocolCodec = {
  readonly encodeClient: (frame: ClientFrame) => string;
  readonly decodeServer: (wire: string) => ServerFrame;
};

export const jsonSyncProtocolCodec: SyncProtocolCodec = {
  encodeClient(frame) {
    return JSON.stringify(frame);
  },
  decodeServer(wire) {
    const value: unknown = JSON.parse(wire);
    assertServerFrame(value);
    return value;
  },
};

function assertServerFrame(value: unknown): asserts value is ServerFrame {
  if (!isObject(value)) {
    throw new TypeError("server frame is missing its type");
  }
  if (!hasStringType(value)) {
    throw new TypeError("server frame is missing its type");
  }
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function hasStringType(value: object): value is Record<"type", string> {
  return "type" in value && typeof value.type === "string";
}
