import { Effect, ManagedRuntime } from "effect";
import { SpaceClientCoreService, makeSpaceClientCoreLayer, type SpaceClientCore, type SpaceClientPlatform } from "./core";
import type { ChatController, ClientEventHandler, ClientEventName, MediaController, ParticipantsController, ReactionsController, SpaceClient, SpaceClientOptions, WhiteboardController } from "./types";

class PromiseSpaceClient implements SpaceClient {
  readonly media: MediaController;
  readonly chat: ChatController;
  readonly participants: ParticipantsController;
  readonly reactions: ReactionsController;
  readonly whiteboard: WhiteboardController;
  readonly #core: SpaceClientCore;
  readonly #runtime: ManagedRuntime.ManagedRuntime<SpaceClientCoreService, never>;
  #disposed = false;

  constructor(options: SpaceClientOptions, platform?: SpaceClientPlatform) {
    this.#runtime = ManagedRuntime.make(makeSpaceClientCoreLayer(options, platform));
    this.#core = this.#runtime.runSync(Effect.service(SpaceClientCoreService));
    const controllers = this.#core.controllers;
    this.media = {
      setMicrophoneEnabled: (enabled) => this.#runtime.runPromise(controllers.media.setMicrophoneEnabled(enabled)),
      setCameraEnabled: (enabled) => this.#runtime.runPromise(controllers.media.setCameraEnabled(enabled)),
      setScreenShareEnabled: (enabled) => this.#runtime.runPromise(controllers.media.setScreenShareEnabled(enabled)),
      selectMicrophone: (deviceId) => this.#runtime.runPromise(controllers.media.selectMicrophone(deviceId)),
      selectCamera: (deviceId) => this.#runtime.runPromise(controllers.media.selectCamera(deviceId)),
      selectSpeaker: (deviceId) => this.#runtime.runPromise(controllers.media.selectSpeaker(deviceId)),
      acceptRequest: (requestId) => this.#runtime.runPromise(controllers.media.acceptRequest(requestId)),
      declineRequest: (requestId) => this.#runtime.runPromise(controllers.media.declineRequest(requestId)),
    };
    this.chat = {
      files: {
        upload: (file) => this.#runtime.runPromise(controllers.chat.upload(file)),
        url: controllers.chat.url,
      },
      send: (input) => this.#runtime.runPromise(controllers.chat.send(input)),
      loadOlder: () => this.#runtime.runPromise(controllers.chat.loadOlder()),
      markRead: (messageId) => this.#runtime.runPromise(controllers.chat.markRead(messageId)),
    };
    this.participants = {
      assignRole: (participantId, roleName) => this.#runtime.runPromise(controllers.participants.assignRole(participantId, roleName)),
      mute: (participantId) => this.#runtime.runPromise(controllers.participants.mute(participantId)),
      stopVideo: (participantId) => this.#runtime.runPromise(controllers.participants.stopVideo(participantId)),
      stopScreenShare: (participantId) => this.#runtime.runPromise(controllers.participants.stopScreenShare(participantId)),
      requestMedia: (participantId, kind) => this.#runtime.runPromise(controllers.participants.requestMedia(participantId, kind)),
      remove: (participantId) => this.#runtime.runPromise(controllers.participants.remove(participantId)),
      admit: (requestId) => this.#runtime.runPromise(controllers.participants.admit(requestId)),
      deny: (requestId) => this.#runtime.runPromise(controllers.participants.deny(requestId)),
      raiseHand: () => this.#runtime.runPromise(controllers.participants.raiseHand()),
      lowerHand: () => this.#runtime.runPromise(controllers.participants.lowerHand()),
      renameSelf: (displayName) => this.#runtime.runPromise(controllers.participants.renameSelf(displayName)),
    };
    this.reactions = { send: (emoji) => this.#runtime.runPromise(controllers.reactions.send(emoji)) };
    this.whiteboard = { transport: controllers.whiteboard.transport };
  }

  join = (options?: Parameters<SpaceClient["join"]>[0]): Promise<void> => this.#runtime.runPromise(this.#core.join(options));
  leave = (): Promise<void> => this.#runtime.runPromise(this.#core.leave());
  subscribe = (listener: () => void): (() => void) => this.#core.subscribe(listener);
  getSnapshot = () => this.#core.getSnapshot();
  endEpisode = (): Promise<void> => this.#runtime.runPromise(this.#core.endEpisode());
  extendEpisode = (minutes: number): Promise<void> => this.#runtime.runPromise(this.#core.extendEpisode(minutes));

  on<TEvent extends ClientEventName>(event: TEvent, handler: ClientEventHandler<TEvent>): () => void {
    return this.#core.on(event, handler);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    void this.#runtime.dispose();
  }
}

export function createSpaceClient(options: SpaceClientOptions): SpaceClient {
  return new PromiseSpaceClient(options);
}

export function createSpaceClientForPlatform(options: SpaceClientOptions, platform: SpaceClientPlatform): SpaceClient {
  return new PromiseSpaceClient(options, platform);
}
