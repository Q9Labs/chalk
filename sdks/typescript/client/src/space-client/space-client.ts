import { Effect, ManagedRuntime } from "effect";
import { SpaceClientCoreService, makeSpaceClientCoreLayer, type SpaceClientCore, type SpaceClientPlatform } from "./core";
import { toPromiseController } from "./promise-facade";
import type { ClientEventHandler, ClientEventName, SpaceClient, SpaceClientOptions } from "./types";

class PromiseSpaceClient implements SpaceClient {
  readonly media;
  readonly chat;
  readonly participants;
  readonly offline;
  readonly reactions;
  readonly recording;
  readonly whiteboard;
  readonly #core: SpaceClientCore;
  readonly #runtime: ManagedRuntime.ManagedRuntime<SpaceClientCoreService, never>;
  readonly #logger: SpaceClientOptions["logger"];
  #disposed = false;
  #closing: Promise<void> | undefined;

  constructor(options: SpaceClientOptions, platform?: SpaceClientPlatform) {
    this.#logger = options.logger;
    this.#runtime = ManagedRuntime.make(makeSpaceClientCoreLayer(options, platform));
    this.#core = this.#runtime.runSync(Effect.service(SpaceClientCoreService));
    const controllers = this.#core.controllers;
    this.media = toPromiseController(this.#runtime, controllers.media);
    const chat = toPromiseController(this.#runtime, controllers.chat);
    const { upload, url, resolveUrl, ...chatCommands } = chat;
    this.chat = { ...chatCommands, files: { upload, url, resolveUrl } };
    this.offline = toPromiseController(this.#runtime, controllers.offline);
    this.participants = toPromiseController(this.#runtime, controllers.participants);
    this.reactions = toPromiseController(this.#runtime, controllers.reactions);
    this.recording = toPromiseController(this.#runtime, controllers.recording);
    this.whiteboard = toPromiseController(this.#runtime, controllers.whiteboard);
  }

  join = (options?: Parameters<SpaceClient["join"]>[0]): Promise<void> => this.#runtime.runPromise(this.#core.join(options));
  leave = (): Promise<void> => this.#runtime.runPromise(this.#core.leave());
  close = (): Promise<void> => {
    this.#closing ??= this.#leaveThenDispose();
    return this.#closing;
  };
  subscribe = (listener: () => void): (() => void) => this.#core.subscribe(listener);
  getSnapshot = () => this.#core.getSnapshot();
  endEpisode = (): Promise<void> => this.#runtime.runPromise(this.#core.endEpisode());
  extendEpisode = (minutes: number): Promise<void> => this.#runtime.runPromise(this.#core.extendEpisode(minutes));

  on<TEvent extends ClientEventName>(event: TEvent, handler: ClientEventHandler<TEvent>): () => void {
    return this.#core.on(event, handler);
  }

  async #leaveThenDispose(): Promise<void> {
    try {
      if (!this.#disposed && this.#core.getSnapshot().connection.status !== "left") await this.leave();
    } catch (cause) {
      this.#logger?.warn?.("SpaceClient leave failed while closing", { message: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      this.dispose();
    }
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
