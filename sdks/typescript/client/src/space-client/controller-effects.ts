import type { Clock, Scope } from "effect";
import { Effect } from "effect";
import type { ConnectionLifecycleCapability } from "../connection";
import type { ConnectionDependencies } from "../connection/dependencies";
import { makeChatController, type ChatControllerEffects } from "./chat-controller";
import { makeMediaController, type MediaControllerEffects } from "./media-controller";
import type { MediaDeviceSelection } from "./media-device-selection";
import { makeOfflineActions, type OfflineActionsControllerEffects } from "./offline-actions";
import { makeParticipantsController, type ParticipantsControllerEffects } from "./participants-controller";
import { makeReactionsController, type ReactionsControllerEffects } from "./reactions-controller";
import { makeRecordingController, type RecordingControllerEffects } from "./recording-controller";
import { SpaceStore } from "./store";
import { makeWhiteboardController, type WhiteboardControllerEffects } from "./whiteboard-controller";
export type ControllerEffects = {
  readonly media: MediaControllerEffects;
  readonly offline: OfflineActionsControllerEffects;
  readonly chat: ChatControllerEffects;
  readonly participants: ParticipantsControllerEffects;
  readonly reactions: ReactionsControllerEffects;
  readonly recording: RecordingControllerEffects;
  readonly whiteboard: WhiteboardControllerEffects;
};
/** Native controller composition: no Promise controller wrapper remains. */
export const makeControllerEffects = (input: {
  readonly offlineActionsStorage?: import("./offline-actions-storage").OfflineActionsStorage;
  readonly offlineActionsStorageKey?: string;
  readonly apiBaseUrl: string;
  readonly connection: ConnectionLifecycleCapability;
  readonly store: SpaceStore;
  readonly mediaDeviceSelection: MediaDeviceSelection;
  readonly featureFactories?: Pick<ConnectionDependencies, "createChatFileTransport" | "createWhiteboardClient">;
  readonly fetch?: typeof globalThis.fetch;
}): Effect.Effect<ControllerEffects, never, Clock.Clock | Scope.Scope> =>
  Effect.gen(function* () {
    const offlineActions = yield* makeOfflineActions({ connection: input.connection, store: input.store, storage: input.offlineActionsStorage, storageKey: input.offlineActionsStorageKey });
    const media = yield* makeMediaController(input.connection, input.store, input.mediaDeviceSelection);
    const chat = yield* makeChatController({ connection: input.connection, store: input.store, createTransport: input.featureFactories?.createChatFileTransport, apiBaseUrl: input.apiBaseUrl, fetch: input.fetch, offline: offlineActions });
    const participants = yield* makeParticipantsController(input.connection, input.store, offlineActions);
    const reactions = yield* makeReactionsController(input.connection, input.store);
    const recording = yield* makeRecordingController(input.connection, input.store);
    const whiteboard = yield* makeWhiteboardController(input.connection, input.store, input.featureFactories?.createWhiteboardClient);
    return { media, offline: offlineActions, chat, participants, reactions, recording, whiteboard };
  });
