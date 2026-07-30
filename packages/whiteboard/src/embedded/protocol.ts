import type { WhiteboardCommit, WhiteboardWireElement } from "../collab/wire.js";

export const CHALK_EMBEDDED_WHITEBOARD_BRIDGE_VERSION = 1 as const;
export const CHALK_EMBEDDED_WHITEBOARD_EXCALIDRAW_VERSION = "0.18.1" as const;
export const CHALK_EMBEDDED_WHITEBOARD_RENDERER_BUILD_ID = "chalk-excalidraw-0.18.1-r1" as const;
export const CHALK_EMBEDDED_WHITEBOARD_MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

export type ChalkEmbeddedWhiteboardTheme = "light" | "dark";
export type ChalkEmbeddedWhiteboardViewport = {
  readonly width: number;
  readonly height: number;
  readonly scale: number;
};

export type ChalkEmbeddedWhiteboardOperationResult = { readonly requestId: string; readonly ok: true; readonly result?: unknown } | { readonly requestId: string; readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly recoverable: boolean } };

export type ChalkEmbeddedWhiteboardHostMessage =
  | {
      readonly type: "initialize";
      readonly payload: {
        readonly canDraw: boolean;
        readonly canClear: boolean;
        readonly theme: ChalkEmbeddedWhiteboardTheme;
        readonly localParticipantColor?: string;
      };
    }
  | {
      readonly type: "apply_snapshot";
      readonly payload: {
        readonly sceneId: string;
        readonly revision: string;
        readonly sceneGeneration: string;
        readonly elements: readonly WhiteboardWireElement[];
        readonly appState?: { readonly viewBackgroundColor?: string };
      };
    }
  | {
      readonly type: "apply_update";
      readonly payload: {
        readonly sceneId: string;
        readonly revision: string;
        readonly sceneGeneration: string;
        readonly elements: readonly WhiteboardWireElement[];
      };
    }
  | {
      readonly type: "apply_cursor";
      readonly payload: {
        readonly participantSessionId: string;
        readonly displayName: string;
        readonly x: number;
        readonly y: number;
        readonly occurredAt: string;
      };
    }
  | {
      readonly type: "reset_required";
      readonly payload: {
        readonly sceneId: string;
        readonly reason: "scene_changed" | "cursor_expired" | "gap";
      };
    }
  | {
      readonly type: "set_capabilities";
      readonly payload: { readonly canDraw: boolean; readonly canClear: boolean };
    }
  | { readonly type: "set_viewport"; readonly payload: ChalkEmbeddedWhiteboardViewport }
  | { readonly type: "operation_result"; readonly payload: ChalkEmbeddedWhiteboardOperationResult }
  | {
      readonly type: "provide_file_bytes";
      readonly payload: {
        readonly requestId: string;
        readonly fileId: string;
        readonly mimeType: string;
        readonly dataURL: string;
      };
    }
  | { readonly type: "request_user_export"; readonly payload: { readonly requestId: string; readonly format: "png" | "svg" } }
  | { readonly type: "prepare_close"; readonly payload: { readonly reason: string } };

export type ChalkEmbeddedWhiteboardRendererMessage =
  | {
      readonly type: "ready";
      readonly payload: {
        readonly excalidrawVersion: typeof CHALK_EMBEDDED_WHITEBOARD_EXCALIDRAW_VERSION;
        readonly supportedBridgeVersions: readonly [typeof CHALK_EMBEDDED_WHITEBOARD_BRIDGE_VERSION];
      };
    }
  | {
      readonly type: "local_update";
      readonly payload: {
        readonly requestId: string;
        readonly sceneId: string;
        readonly sceneGeneration: string;
        readonly syncAll: boolean;
        readonly elements: readonly WhiteboardWireElement[];
      };
    }
  | { readonly type: "cursor"; readonly payload: { readonly x: number; readonly y: number } }
  | { readonly type: "camera"; readonly payload: { readonly scrollX: number; readonly scrollY: number; readonly zoom: number } }
  | { readonly type: "request_snapshot"; readonly payload: { readonly requestId: string } }
  | { readonly type: "clear"; readonly payload: { readonly requestId: string } }
  | {
      readonly type: "file_read";
      readonly payload: { readonly requestId: string; readonly fileId: string };
    }
  | {
      readonly type: "file_write";
      readonly payload: {
        readonly requestId: string;
        readonly fileId: string;
        readonly mimeType: string;
        readonly byteLength: number;
        readonly sha256: string;
        readonly dataURL: string;
      };
    }
  | {
      readonly type: "user_export";
      readonly payload: { readonly requestId: string; readonly format: "png" | "svg"; readonly mimeType: string; readonly dataURL: string };
    }
  | {
      readonly type: "metric";
      readonly payload: { readonly name: string; readonly value: number; readonly attributes?: Readonly<Record<string, string | number | boolean>> };
    }
  | {
      readonly type: "error";
      readonly payload: { readonly code: string; readonly message: string; readonly recoverable: boolean };
    }
  | { readonly type: "close_ready"; readonly payload: { readonly reason: string } };

export type ChalkEmbeddedWhiteboardBridgeEnvelope<Message extends { readonly type: string; readonly payload: unknown }> = Message extends unknown
  ? {
      readonly bridgeVersion: typeof CHALK_EMBEDDED_WHITEBOARD_BRIDGE_VERSION;
      readonly rendererBuildId: typeof CHALK_EMBEDDED_WHITEBOARD_RENDERER_BUILD_ID;
      readonly rendererGeneration: string;
      readonly messageId: string;
      readonly payloadBytes: number;
      readonly journeyId: string;
      readonly traceparent?: string;
      readonly tracestate?: string;
      readonly type: Message["type"];
      readonly payload: Message["payload"];
    }
  : never;

export type ChalkEmbeddedWhiteboardHostEnvelope = ChalkEmbeddedWhiteboardBridgeEnvelope<ChalkEmbeddedWhiteboardHostMessage>;
export type ChalkEmbeddedWhiteboardRendererEnvelope = ChalkEmbeddedWhiteboardBridgeEnvelope<ChalkEmbeddedWhiteboardRendererMessage>;

export interface ChalkEmbeddedWhiteboardMessageContext {
  readonly rendererGeneration: string;
  readonly journeyId: string;
  readonly traceparent?: string;
  readonly tracestate?: string;
  readonly nextMessageId: () => string;
}

export function encodeEmbeddedWhiteboardMessage<Message extends { readonly type: string; readonly payload: unknown }>(message: Message, context: ChalkEmbeddedWhiteboardMessageContext): string {
  const payloadBytes = encodedBytes(message.payload);
  if (payloadBytes > CHALK_EMBEDDED_WHITEBOARD_MAX_MESSAGE_BYTES) {
    throw new Error("embedded whiteboard message payload exceeds the bridge limit");
  }

  const encoded = JSON.stringify({
    bridgeVersion: CHALK_EMBEDDED_WHITEBOARD_BRIDGE_VERSION,
    rendererBuildId: CHALK_EMBEDDED_WHITEBOARD_RENDERER_BUILD_ID,
    rendererGeneration: requireBoundedString(context.rendererGeneration, "renderer generation", 128),
    messageId: requireBoundedString(context.nextMessageId(), "message ID", 128),
    payloadBytes,
    journeyId: requireBoundedString(context.journeyId, "journey ID", 256),
    ...(context.traceparent ? { traceparent: requireTraceparent(context.traceparent) } : {}),
    ...(context.tracestate ? { tracestate: requireBoundedString(context.tracestate, "tracestate", 512) } : {}),
    type: message.type,
    payload: message.payload,
  });
  if (encodedBytes(encoded) > CHALK_EMBEDDED_WHITEBOARD_MAX_MESSAGE_BYTES) {
    throw new Error("embedded whiteboard message exceeds the bridge limit");
  }
  return encoded;
}

export function decodeEmbeddedWhiteboardHostMessage(value: string, expectedGeneration?: string): ChalkEmbeddedWhiteboardHostEnvelope {
  return decodeEnvelope(value, expectedGeneration, hostMessageTypes) as ChalkEmbeddedWhiteboardHostEnvelope;
}

export function decodeEmbeddedWhiteboardRendererMessage(value: string, expectedGeneration?: string): ChalkEmbeddedWhiteboardRendererEnvelope {
  return decodeEnvelope(value, expectedGeneration, rendererMessageTypes) as ChalkEmbeddedWhiteboardRendererEnvelope;
}

const hostMessageTypes = new Set<ChalkEmbeddedWhiteboardHostMessage["type"]>(["initialize", "apply_snapshot", "apply_update", "apply_cursor", "reset_required", "set_capabilities", "set_viewport", "operation_result", "provide_file_bytes", "request_user_export", "prepare_close"]);

const rendererMessageTypes = new Set<ChalkEmbeddedWhiteboardRendererMessage["type"]>(["ready", "local_update", "cursor", "camera", "request_snapshot", "clear", "file_read", "file_write", "user_export", "metric", "error", "close_ready"]);

function decodeEnvelope(value: string, expectedGeneration: string | undefined, allowedTypes: ReadonlySet<string>): ChalkEmbeddedWhiteboardBridgeEnvelope<{ type: string; payload: unknown }> {
  if (encodedBytes(value) > CHALK_EMBEDDED_WHITEBOARD_MAX_MESSAGE_BYTES) throw new Error("embedded whiteboard message exceeds the bridge limit");

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("embedded whiteboard message is not valid JSON");
  }
  if (!isRecord(parsed) || !hasOnlyEnvelopeKeys(parsed)) throw new Error("embedded whiteboard message envelope is invalid");
  if (parsed.bridgeVersion !== CHALK_EMBEDDED_WHITEBOARD_BRIDGE_VERSION) throw new Error("embedded whiteboard bridge version is unsupported");
  if (parsed.rendererBuildId !== CHALK_EMBEDDED_WHITEBOARD_RENDERER_BUILD_ID) throw new Error("embedded whiteboard renderer build is unsupported");
  const rendererGeneration = requireBoundedString(parsed.rendererGeneration, "renderer generation", 128);
  if (expectedGeneration && rendererGeneration !== expectedGeneration) throw new Error("embedded whiteboard renderer generation is stale");
  const type = requireBoundedString(parsed.type, "message type", 64);
  if (!allowedTypes.has(type)) throw new Error("embedded whiteboard message type is unsupported");
  const payloadBytes = parsed.payloadBytes;
  if (!Number.isSafeInteger(payloadBytes) || Number(payloadBytes) < 0 || Number(payloadBytes) !== encodedBytes(parsed.payload)) {
    throw new Error("embedded whiteboard payload byte count is invalid");
  }
  if (Number(payloadBytes) > CHALK_EMBEDDED_WHITEBOARD_MAX_MESSAGE_BYTES) throw new Error("embedded whiteboard message payload exceeds the bridge limit");

  return {
    bridgeVersion: CHALK_EMBEDDED_WHITEBOARD_BRIDGE_VERSION,
    rendererBuildId: CHALK_EMBEDDED_WHITEBOARD_RENDERER_BUILD_ID,
    rendererGeneration,
    messageId: requireBoundedString(parsed.messageId, "message ID", 128),
    payloadBytes: Number(payloadBytes),
    journeyId: requireBoundedString(parsed.journeyId, "journey ID", 256),
    ...(parsed.traceparent ? { traceparent: requireTraceparent(parsed.traceparent) } : {}),
    ...(parsed.tracestate ? { tracestate: requireBoundedString(parsed.tracestate, "tracestate", 512) } : {}),
    type,
    payload: parsed.payload,
  };
}

function hasOnlyEnvelopeKeys(value: Record<string, unknown>): boolean {
  const allowed = new Set(["bridgeVersion", "rendererBuildId", "rendererGeneration", "messageId", "payloadBytes", "journeyId", "traceparent", "tracestate", "type", "payload"]);
  return Object.keys(value).every((key) => allowed.has(key)) && ["bridgeVersion", "rendererBuildId", "rendererGeneration", "messageId", "payloadBytes", "journeyId", "type", "payload"].every((key) => Object.hasOwn(value, key));
}

function requireBoundedString(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || encodedBytes(value) > maxBytes) throw new Error(`embedded whiteboard ${label} is invalid`);
  return value;
}

function requireTraceparent(value: unknown): string {
  const traceparent = requireBoundedString(value, "traceparent", 128);
  const match = /^([\da-f]{2})-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})$/iu.exec(traceparent);
  if (!match || match[1]?.toLowerCase() === "ff" || /^0{32}$/u.test(match[2] ?? "") || /^0{16}$/u.test(match[3] ?? "")) {
    throw new Error("embedded whiteboard traceparent is invalid");
  }
  return traceparent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)).byteLength;
}

export type ChalkEmbeddedWhiteboardCommit = WhiteboardCommit;
