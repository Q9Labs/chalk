import { Effect, ManagedRuntime } from "effect";
import { SpaceClientCoreService, makeSpaceClientCoreLayer, type SpaceClientCore, type SpaceClientPlatform } from "./core";
import { toPromiseController } from "./promise-facade";
import type { ClientEventHandler, ClientEventName, SpaceClient, SpaceClientOptions } from "./types";

class PromiseSpaceClient implements SpaceClient {
  readonly media;
  readonly chat;
  readonly participants;
  readonly reactions;
  readonly whiteboard;
  readonly #core: SpaceClientCore;
  readonly #runtime: ManagedRuntime.ManagedRuntime<SpaceClientCoreService, never>;
  #disposed = false;

  constructor(options: SpaceClientOptions, platform?: SpaceClientPlatform) {
    this.#runtime = ManagedRuntime.make(makeSpaceClientCoreLayer(options, platform));
    this.#core = this.#runtime.runSync(Effect.service(SpaceClientCoreService));
    const controllers = this.#core.controllers;
    this.media = toPromiseController(this.#runtime, controllers.media);
    const chat = toPromiseController(this.#runtime, controllers.chat);
    const { upload, url, ...chatCommands } = chat;
    this.chat = { ...chatCommands, files: { upload, url } };
    this.participants = toPromiseController(this.#runtime, controllers.participants);
    this.reactions = toPromiseController(this.#runtime, controllers.reactions);
    this.whiteboard = toPromiseController(this.#runtime, controllers.whiteboard);
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
