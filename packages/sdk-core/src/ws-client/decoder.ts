import { Schema } from "@effect/schema";

import { WSMessage, WSPayloadSchemas } from "../effect/schemas/ws-events.ts";
import { snakeToCamel, snakeToCamelExcept } from "../transforms.ts";
import type { WSInboundMessage, WSInboundPayloadMap, WSInboundType } from "./messages.ts";

const MAX_RAW_LEN = 2_000;

const truncate = (raw: string) => (raw.length > MAX_RAW_LEN ? `${raw.slice(0, MAX_RAW_LEN)}…` : raw);

const isInboundType = (type: string): type is WSInboundType => Object.prototype.hasOwnProperty.call(WSPayloadSchemas, type);

const decodeEnvelope = Schema.decodeUnknownSync(WSMessage);

const decodePayload = <K extends WSInboundType>(type: K, payload: unknown): WSInboundPayloadMap[K] => {
  // TS can't correlate object index access with the key here; keep runtime schema validation,
  // then cast to the schema-derived type for this message type.
  const schema = WSPayloadSchemas[type] as unknown;
  return Schema.decodeUnknownSync(schema as any)(payload) as WSInboundPayloadMap[K];
};

export const decodeIncomingMessage = (raw: string) => {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false as const,
      error: {
        stage: "json_parse" as const,
        message: err instanceof Error ? err.message : String(err),
        raw: truncate(raw),
      },
    };
  }

  let envelope: Schema.Schema.Type<typeof WSMessage>;
  try {
    envelope = decodeEnvelope(json);
  } catch (err) {
    return {
      ok: false as const,
      error: {
        stage: "envelope" as const,
        message: err instanceof Error ? err.message : String(err),
        raw: truncate(raw),
      },
    };
  }

  const payload = envelope.payload === undefined ? undefined : envelope.type === "whiteboard.data" || envelope.type === "whiteboard.snapshot" ? snakeToCamelExcept(envelope.payload, ["elements"]) : snakeToCamel(envelope.payload);

  if (!isInboundType(envelope.type)) {
    return {
      ok: true as const,
      known: false as const,
      message: { type: envelope.type, payload },
    };
  }

  try {
    const decodedPayload = decodePayload(envelope.type, payload);
    return {
      ok: true as const,
      known: true as const,
      message: { type: envelope.type, payload: decodedPayload } as WSInboundMessage,
    };
  } catch (err) {
    return {
      ok: false as const,
      error: {
        stage: "payload" as const,
        type: envelope.type,
        message: err instanceof Error ? err.message : String(err),
        raw: truncate(raw),
      },
    };
  }
};

export type DecodeIncomingMessageResult = ReturnType<typeof decodeIncomingMessage>;
