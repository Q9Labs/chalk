import { Schema } from "effect";
import { ChatAttachmentMimeTypeSchema } from "../generated/sync";

/** Synchronous storage seam; native consumers can supply MMKV or a hydrated adapter. */
export type OfflineActionsStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export const OFFLINE_ACTION_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export function browserOfflineActionsStorage(): OfflineActionsStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return globalThis.localStorage;
  } catch {
    // Storage may be disabled by the browser. The in-memory queue still works.
    return undefined;
  }
}

const attachment = Schema.Struct({ attachmentId: Schema.String, fileName: Schema.String, mimeType: ChatAttachmentMimeTypeSchema, byteLength: Schema.Number });
export const StoredOfflineAction = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["chat_message", "hand_raise", "hand_lower"]),
  text: Schema.NullOr(Schema.String),
  queuedAt: Schema.Number,
  clientMessageId: Schema.optional(Schema.String),
  attachments: Schema.optional(Schema.Array(attachment)),
});
export type StoredOfflineAction = typeof StoredOfflineAction.Type;
export const StoredOfflineActions = Schema.Struct({
  version: Schema.Literal(1),
  subject: Schema.Struct({ tenantId: Schema.String, spaceId: Schema.String, episodeId: Schema.String, participantId: Schema.String, participantGeneration: Schema.Number }),
  actions: Schema.Array(StoredOfflineAction),
});
export const decodeOfflineActions = Schema.decodeUnknownSync(StoredOfflineActions);
