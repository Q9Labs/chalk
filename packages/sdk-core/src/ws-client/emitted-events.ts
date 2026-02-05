import type { Schema } from "@effect/schema";
import { WSEventSchemas } from "../effect/schemas/ws-emitted.ts";

export type WSEvents = {
	[K in keyof typeof WSEventSchemas]: Schema.Schema.Type<
		(typeof WSEventSchemas)[K]
	>;
};
