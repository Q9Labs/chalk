import { createBrowserSyncLifecycle, createBrowserWebSocketFactory } from "./browser";
import { SyncClient, type SyncClientOptions } from "./client";
import { IndexedDbPendingCommandStore, type IndexedDbPendingCommandStoreOptions } from "./indexeddb";
import { syncV2ProtocolCodec } from "./v2-codec";
import { type PendingCommandStore } from "./persistence";
import { SyncCommandValidationError } from "./errors";
import type { SyncLifecycle, SyncWebSocketFactory } from "./types";
import type { SyncProtocolCodec } from "./protocol";

export type CreateSyncClientOptions = Omit<SyncClientOptions, "codec" | "lifecycle" | "pendingStore" | "webSocket"> & {
  readonly codec?: SyncProtocolCodec;
  readonly lifecycle?: SyncLifecycle;
  readonly pendingStore?: PendingCommandStore;
  readonly webSocket?: SyncWebSocketFactory;
  readonly indexedDb?: Omit<IndexedDbPendingCommandStoreOptions, "scope">;
  readonly persistenceScope?: string;
};

export function createSyncClient(options: CreateSyncClientOptions): SyncClient {
  const { codec, indexedDb, lifecycle, pendingStore, persistenceScope, webSocket, ...clientOptions } = options;
  return new SyncClient({
    ...clientOptions,
    codec: valueOrCreate(codec, () => syncV2ProtocolCodec),
    lifecycle: valueOrCreate(lifecycle, createBrowserSyncLifecycle),
    pendingStore: valueOrCreate(pendingStore, () => browserPendingStore(persistenceScope, indexedDb)),
    webSocket: valueOrCreate(webSocket, createBrowserWebSocketFactory),
  });
}

function valueOrCreate<T>(value: T | undefined, create: () => T): T {
  return value === undefined ? create() : value;
}

function browserPendingStore(persistenceScope: string | undefined, indexedDb: Omit<IndexedDbPendingCommandStoreOptions, "scope"> | undefined): PendingCommandStore {
  if (!persistenceScope) {
    throw new SyncCommandValidationError("persistenceScope is required when no pendingStore is supplied");
  }
  return new IndexedDbPendingCommandStore({ ...indexedDb, scope: persistenceScope });
}
