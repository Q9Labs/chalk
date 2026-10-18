import type { ClientEventHandler, ClientEventMap, ClientEventName } from "@q9labsai/chalk-client";

/** Mapped storage keeps each event payload paired with its handler without assertions. */
export function createFixtureEvents() {
  const handlers: { [K in ClientEventName]: Set<ClientEventHandler<K>> } = {
    participantJoined: new Set(),
    participantLeft: new Set(),
    episodeEnded: new Set(),
    screenShareStarted: new Set(),
    screenShareStopped: new Set(),
    error: new Set(),
  };
  return {
    on<K extends ClientEventName>(event: K, handler: ClientEventHandler<K>) {
      handlers[event].add(handler);
      return () => {
        handlers[event].delete(handler);
      };
    },
    emit<K extends ClientEventName>(event: K, payload: ClientEventMap[K]) {
      for (const handler of handlers[event]) handler(payload);
    },
    clear() {
      for (const set of Object.values(handlers)) set.clear();
    },
  };
}
