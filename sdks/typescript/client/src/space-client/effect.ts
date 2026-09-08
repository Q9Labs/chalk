import { Context, Effect, Exit, Layer, Scope } from "effect";
import type { ChalkChatPageResult, ChalkDirectedRequestResult } from "../collaboration/types";
import type { ChalkWhiteboardV1Transport } from "../whiteboard/types";
import type { ControllerEffects } from "./controller-effects";
import { SpaceClientCore, SpaceClientCoreService, makeSpaceClientCoreLayer, type SpaceClientPlatform } from "./core";
import type { SpaceClientError } from "./errors";
import type { ActiveReaction, ChatAttachment, ChatMessage, ChatReadReceipt, ChatSendInput, ChatUploadFile, ClientEventHandler, ClientEventName, JoinOptions, MediaRequestKind, Reaction, SpaceClientOptions, SpaceSnapshot } from "./types";
import type { FeedbackController } from "../feedback/types";

type ClientEffect<T> = Effect.Effect<T, SpaceClientError>;

export type EffectMediaController = ControllerEffects["media"];
export type EffectChatController = {
  readonly files: {
    readonly upload: (file: ChatUploadFile) => ClientEffect<ChatAttachment>;
    readonly url: (attachment: ChatAttachment) => string;
  };
  readonly send: (input: ChatSendInput) => ClientEffect<ChatMessage>;
  readonly loadOlder: () => ClientEffect<ChalkChatPageResult>;
  readonly markRead: (messageId: string) => ClientEffect<ChatReadReceipt | null>;
};
export type EffectParticipantsController = ControllerEffects["participants"];
export type EffectReactionsController = ControllerEffects["reactions"];
export type EffectWhiteboardController = { readonly transport: () => ChalkWhiteboardV1Transport | null };

export type EffectSpaceClient = {
  readonly feedback: FeedbackController;
  readonly media: EffectMediaController;
  readonly chat: EffectChatController;
  readonly participants: EffectParticipantsController;
  readonly reactions: EffectReactionsController;
  readonly whiteboard: EffectWhiteboardController;
  readonly join: (options?: JoinOptions) => ClientEffect<void>;
  readonly leave: () => ClientEffect<void>;
  readonly dispose: () => Effect.Effect<void, unknown>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly changes: import("effect").Stream.Stream<SpaceSnapshot>;
  readonly getSnapshot: () => SpaceSnapshot;
  readonly endEpisode: () => ClientEffect<void>;
  readonly extendEpisode: (minutes: number) => ClientEffect<void>;
  readonly on: <TEvent extends ClientEventName>(event: TEvent, handler: ClientEventHandler<TEvent>) => () => void;
};

export function createEffectSpaceClient(options: SpaceClientOptions, platform?: SpaceClientPlatform): Effect.Effect<EffectSpaceClient, never, Scope.Scope> {
  return Effect.gen(function* () {
    const parentScope = yield* Effect.scope;
    const scope = yield* Scope.fork(parentScope, "sequential");
    const context = yield* Layer.buildWithScope(makeSpaceClientCoreLayer(options, platform), scope);
    const core = Context.get(context, SpaceClientCoreService);
    return effectClientFromCore(core, () => Scope.close(scope, Exit.void));
  });
}

export function effectClientFromCore(core: SpaceClientCore, dispose: () => Effect.Effect<void, unknown> = () => Effect.sync(() => core.dispose())): EffectSpaceClient {
  return {
    feedback: core.feedback,
    media: core.controllers.media,
    chat: {
      send: core.controllers.chat.send,
      loadOlder: core.controllers.chat.loadOlder,
      markRead: core.controllers.chat.markRead,
      files: { upload: core.controllers.chat.upload, url: core.controllers.chat.url },
    },
    participants: core.controllers.participants,
    reactions: core.controllers.reactions,
    whiteboard: core.controllers.whiteboard,
    join: (options) => core.join(options),
    leave: () => core.leave(),
    dispose,
    subscribe: core.subscribe,
    changes: core.changes,
    getSnapshot: core.getSnapshot,
    endEpisode: () => core.endEpisode(),
    extendEpisode: (minutes) => core.extendEpisode(minutes),
    on: (event, handler) => core.on(event, handler),
  };
}

export type { SpaceClientPlatform } from "./core";
export type { ChalkChatPageResult, ChalkDirectedRequestResult, MediaRequestKind, Reaction, ActiveReaction };
