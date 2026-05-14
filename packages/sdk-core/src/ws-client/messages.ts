import { Schema } from "@effect/schema";

import { WSPayloadSchemas } from "../effect/schemas/ws-events.ts";
import { WSOutboundPayloadSchemas } from "../effect/schemas/ws-outbound.ts";

export type WSInboundType = keyof typeof WSPayloadSchemas;

export type WSInboundPayloadMap = {
  [K in WSInboundType]: Schema.Schema.Type<(typeof WSPayloadSchemas)[K]>;
};

export type WSInboundMessage = {
  [K in WSInboundType]: { type: K; payload: WSInboundPayloadMap[K] };
}[WSInboundType];

export type WSOutboundType = keyof typeof WSOutboundPayloadSchemas;

export type WSOutboundPayloadMap = {
  [K in WSOutboundType]: Schema.Schema.Type<(typeof WSOutboundPayloadSchemas)[K]>;
};

type WithPayload<K extends string, P> = [P] extends [void] ? { type: K; payload?: P } : { type: K; payload: P };

export type WSOutboundMessage = {
  [K in WSOutboundType]: WithPayload<K, WSOutboundPayloadMap[K]>;
}[WSOutboundType];
