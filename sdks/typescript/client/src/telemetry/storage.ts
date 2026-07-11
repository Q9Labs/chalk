import { createUuid } from "./random";
import type { TelemetryEvent } from "./types";

export interface TelemetryStorage {
  load(): Promise<readonly TelemetryEvent[]>;
  save(events: readonly TelemetryEvent[]): Promise<void>;
}

export interface TelemetryKeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

interface RuntimeTelemetryStorageState {
  readonly adoptedQueues: Map<string, string>;
  readonly knownEventIds: Set<string>;
  readonly retainedEvents: Map<string, TelemetryEvent>;
  loaded: boolean;
}

export function createMemoryTelemetryStorage(initialEvents: readonly TelemetryEvent[] = []): TelemetryStorage {
  let events = [...initialEvents];

  return {
    async load() {
      return [...events];
    },
    async save(nextEvents) {
      events = [...nextEvents];
    },
  };
}

/** Adapts browser storage, Expo storage, or another platform key-value store without adding a platform dependency. */
export function createKeyValueTelemetryStorage(storage: TelemetryKeyValueStorage, key = "chalk.telemetry.v1"): TelemetryStorage {
  return {
    async load() {
      const value = await storage.getItem(key);
      if (!value) {
        return [];
      }

      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as TelemetryEvent[]) : [];
    },
    async save(events) {
      await storage.setItem(key, JSON.stringify(events));
    },
  };
}

export function createBrowserTelemetryStorage(key = "chalk.telemetry.v1"): TelemetryStorage | undefined {
  const storage = getBrowserLocalStorage();
  if (!storage) return undefined;

  return createKeyValueTelemetryStorage(
    {
      async getItem(storageKey) {
        return storage.getItem(storageKey);
      },
      async setItem(storageKey, value) {
        storage.setItem(storageKey, value);
      },
    },
    key,
  );
}

/**
 * Creates a durable localStorage queue with a unique runtime key.
 *
 * Each runtime preserves its own queue and adopts sibling queues when it starts.
 * This avoids cross-tab overwrites while allowing a later tab to recover journeys
 * left behind by a closed tab.
 */
export function createBrowserRuntimeTelemetryStorage(keyPrefix = "chalk.telemetry.v1"): TelemetryStorage | undefined {
  const storage = getBrowserLocalStorage();
  if (!storage) return undefined;

  const key = `${keyPrefix}.${createUuid()}`;
  const state = createRuntimeTelemetryStorageState();

  return {
    async load() {
      return loadRuntimeQueue(storage, keyPrefix, key, state);
    },
    async save(events) {
      saveRuntimeQueue(storage, keyPrefix, key, state, events);
    },
  };
}

function getBrowserLocalStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function createRuntimeTelemetryStorageState(): RuntimeTelemetryStorageState {
  return {
    adoptedQueues: new Map(),
    knownEventIds: new Set(),
    retainedEvents: new Map(),
    loaded: false,
  };
}

function loadRuntimeQueue(storage: Storage, keyPrefix: string, ownKey: string, state: RuntimeTelemetryStorageState): TelemetryEvent[] {
  const recovered = adoptQueues(storage, keyPrefix, ownKey, state.adoptedQueues);
  markKnownEvents(state, recovered);
  state.loaded = true;
  return recovered;
}

function saveRuntimeQueue(storage: Storage, keyPrefix: string, ownKey: string, state: RuntimeTelemetryStorageState, events: readonly TelemetryEvent[]): void {
  ensureRuntimeQueueLoaded(storage, keyPrefix, ownKey, state);
  const currentEvents = trackCurrentEvents(state, events);
  retainUnseenAdoptedEvents(state, currentEvents, recoverAdoptedQueues(storage, state.adoptedQueues));
  persistRuntimeQueue(storage, ownKey, state, currentEvents);
}

function ensureRuntimeQueueLoaded(storage: Storage, keyPrefix: string, ownKey: string, state: RuntimeTelemetryStorageState): void {
  if (state.loaded) return;
  loadRuntimeQueue(storage, keyPrefix, ownKey, state);
}

function trackCurrentEvents(state: RuntimeTelemetryStorageState, events: readonly TelemetryEvent[]): TelemetryEvent[] {
  const currentEvents = dedupeEvents(events);
  markKnownEvents(state, currentEvents);
  for (const event of currentEvents) state.retainedEvents.delete(event.event_id);
  return currentEvents;
}

function markKnownEvents(state: RuntimeTelemetryStorageState, events: readonly TelemetryEvent[]): void {
  for (const event of events) state.knownEventIds.add(event.event_id);
}

function retainUnseenAdoptedEvents(state: RuntimeTelemetryStorageState, currentEvents: readonly TelemetryEvent[], recovered: readonly TelemetryEvent[]): void {
  const currentEventIds = new Set(currentEvents.map((event) => event.event_id));
  for (const event of recovered) {
    if (!currentEventIds.has(event.event_id) && !state.knownEventIds.has(event.event_id)) {
      state.retainedEvents.set(event.event_id, event);
    }
  }
}

function persistRuntimeQueue(storage: Storage, ownKey: string, state: RuntimeTelemetryStorageState, currentEvents: readonly TelemetryEvent[]): void {
  const persistedEvents = dedupeEvents([...currentEvents, ...state.retainedEvents.values()]);
  storage.setItem(ownKey, JSON.stringify(persistedEvents));
  removeAdoptedQueues(storage, state.adoptedQueues);
}

function adoptQueues(storage: Storage, keyPrefix: string, ownKey: string, adoptedQueues: Map<string, string>): TelemetryEvent[] {
  return readAndAdoptQueues(storage, runtimeQueueKeys(storage, keyPrefix, ownKey), adoptedQueues);
}

function runtimeQueueKeys(storage: Storage, keyPrefix: string, ownKey: string): string[] {
  return storageKeys(storage).filter((key) => key !== ownKey && isRuntimeTelemetryKey(key, keyPrefix));
}

function readAndAdoptQueues(storage: Storage, keys: readonly string[], adoptedQueues: Map<string, string>): TelemetryEvent[] {
  const recovered: TelemetryEvent[] = [];

  for (const key of keys) {
    const value = storage.getItem(key);
    if (value === null) continue;
    const events = parseEvents(value);
    if (!events) {
      storage.removeItem(key);
      continue;
    }
    adoptedQueues.set(key, value);
    recovered.push(...events);
  }

  return dedupeEvents(recovered);
}

function recoverAdoptedQueues(storage: Storage, adoptedQueues: Map<string, string>): TelemetryEvent[] {
  const recovered: TelemetryEvent[] = [];

  for (const key of adoptedQueues.keys()) {
    const value = storage.getItem(key);
    if (value === null) {
      adoptedQueues.delete(key);
      continue;
    }
    const events = parseEvents(value);
    if (!events) {
      storage.removeItem(key);
      adoptedQueues.delete(key);
      continue;
    }
    adoptedQueues.set(key, value);
    recovered.push(...events);
  }

  return dedupeEvents(recovered);
}

function removeAdoptedQueues(storage: Storage, adoptedQueues: Map<string, string>): void {
  for (const [key, value] of adoptedQueues) {
    if (storage.getItem(key) !== value) continue;
    storage.removeItem(key);
    adoptedQueues.delete(key);
  }
}

function storageKeys(storage: Storage): string[] {
  return Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string => key !== null);
}

function isRuntimeTelemetryKey(key: string, keyPrefix: string): boolean {
  return key === keyPrefix || key.startsWith(`${keyPrefix}.`);
}

function parseEvents(value: string): TelemetryEvent[] | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as TelemetryEvent[]) : [];
  } catch {
    return undefined;
  }
}

function dedupeEvents(events: Iterable<TelemetryEvent>): TelemetryEvent[] {
  const unique = new Map<string, TelemetryEvent>();
  for (const event of events) unique.set(event.event_id, event);
  return [...unique.values()];
}
