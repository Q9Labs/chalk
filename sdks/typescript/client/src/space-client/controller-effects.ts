import { Context, Effect, Layer } from "effect";
import { sha256 } from "@noble/hashes/sha2.js";
import type { ChalkChatFileTransport } from "../chat-files";
import type { ConnectionLifecycleCapability } from "../connection";
import type { ConnectionDependencies } from "../connection/dependencies";
import { makeChatController, type ChatControllerEffects } from "./chat-controller";
import type { EpisodeDiagnosticRuntime } from "./episode-diagnostic-runtime";
import { normalizeClientError, SpaceClientError } from "./errors";
import { makeMediaController, type MediaControllerEffects } from "./media-controller";
import type { MediaDeviceSelection } from "./media-device-selection";
import { makeParticipantsController, type ParticipantsControllerEffects } from "./participants-controller";
import { makeReactionsController, type ReactionsControllerEffects } from "./reactions-controller";
import { SpaceStore } from "./store";
import type { ActiveReaction, ChatAttachment, ChatMessage, ChatReadReceipt, ChatSendInput, ChatUploadFile, MediaRequestKind, Reaction } from "./types";
import { makeWhiteboardController, type WhiteboardControllerEffects } from "./whiteboard-controller";

type ClientEffect<A> = Effect.Effect<A, SpaceClientError>;
export type ControllerEffects = {
  readonly media: MediaControllerEffects;
  readonly chat: ChatControllerEffects;
  readonly participants: ParticipantsControllerEffects;
  readonly reactions: ReactionsControllerEffects;
  readonly whiteboard: WhiteboardControllerEffects;
};
export class ControllerEffectsService extends Context.Service<ControllerEffectsService, ControllerEffects>()("@chalk/client/ControllerEffects") {}

/** Native controller composition: no Promise controller wrapper remains. */
export const makeControllerEffects = (input: {
  readonly apiBaseUrl: string;
  readonly connection: ConnectionLifecycleCapability;
  readonly store: SpaceStore;
  readonly mediaDeviceSelection: MediaDeviceSelection;
  readonly featureFactories?: Pick<ConnectionDependencies, "createChatFileTransport" | "createWhiteboardClient">;
  readonly fetch?: typeof globalThis.fetch;
  /** Private semantic diagnostics owner; never exposed through the public controller surface. */
  readonly episodeDiagnostics?: EpisodeDiagnosticRuntime;
}): Effect.Effect<ControllerEffects, never, import("effect").Clock.Clock | import("effect").Scope.Scope> =>
  Effect.gen(function* () {
    const media = yield* makeMediaController(input.connection, input.store, input.mediaDeviceSelection, input.episodeDiagnostics);
    const chat = yield* makeChatController({ connection: input.connection, store: input.store, createTransport: input.featureFactories?.createChatFileTransport, apiBaseUrl: input.apiBaseUrl, fetch: input.fetch, episodeDiagnostics: input.episodeDiagnostics });
    const participants = yield* makeParticipantsController(input.connection, input.store, input.episodeDiagnostics);
    const reactions = yield* makeReactionsController(input.connection, input.store, input.episodeDiagnostics);
    const whiteboard = yield* makeWhiteboardController(input.connection, input.store, input.featureFactories?.createWhiteboardClient);
    return { media, chat, participants, reactions, whiteboard };
  });

export const makeControllerEffectsLayer = (input: Parameters<typeof makeControllerEffects>[0]) => Layer.effect(ControllerEffectsService, makeControllerEffects(input));

/** Standalone native upload effect for custom native controller assembly. */
export function uploadFileEffect(file: ChatUploadFile, input: { readonly connection: ConnectionLifecycleCapability; readonly chatFiles: ChalkChatFileTransport | null; readonly fetch: typeof globalThis.fetch }): ClientEffect<ChatAttachment> {
  if (!input.chatFiles) return Effect.fail(new SpaceClientError({ code: "collaboration.unavailable", recoverable: false, message: "Chat file upload is unavailable" }));
  return bytesFor(file).pipe(
    Effect.flatMap((bytes) => {
      const clientAttachmentId = input.connection.createId();
      const fileName = "fileName" in file ? file.fileName : file.name;
      const mimeType = "mimeType" in file ? file.mimeType : file.type;
      const digest = [...sha256(new Uint8Array(bytes))].map((value) => value.toString(16).padStart(2, "0")).join("");
      return input.connection.runPortCommand(() =>
        foreign(() => input.chatFiles!.initiateUpload({ clientAttachmentId, fileName, mimeType: mimeType as ChatAttachment["mimeType"], byteLength: bytes.byteLength, sha256: digest })).pipe(
          Effect.flatMap((upload) =>
            foreign(() => input.fetch(upload.uploadUrl, { method: upload.method, headers: upload.headers, body: bytes })).pipe(
              Effect.flatMap((response) => (response.ok ? foreign(() => input.chatFiles!.finalizeUpload(upload.uploadId)) : Effect.fail(new SpaceClientError({ code: "command.rejected", recoverable: response.status >= 500, message: `Attachment upload failed with HTTP ${response.status}` })))),
            ),
          ),
        ),
      );
    }),
    Effect.mapError(normalizeClientError),
  );
}

function foreign<A>(operation: () => Promise<A>): Effect.Effect<A, unknown> {
  return Effect.tryPromise({ try: operation, catch: (cause) => cause });
}
function bytesFor(file: ChatUploadFile): Effect.Effect<ArrayBuffer, unknown> {
  return "bytes" in file ? Effect.succeed(file.bytes) : foreign(() => file.arrayBuffer());
}

export type { ActiveReaction, ChatAttachment, ChatMessage, ChatReadReceipt, ChatSendInput, MediaRequestKind, Reaction };
