import { createBrowserSyncLifecycle, createBrowserWebSocketFactory } from "./browser";
import { V3SyncClient } from "./v3-client";
import { IndexedDbV3PendingTargetStore, type IndexedDbV3PendingTargetStoreOptions } from "./v3-platform-persistence";
import type { V3SyncClientOptions } from "./v3-types";

export type CreateV3SyncClientOptions = Omit<V3SyncClientOptions, "lifecycle" | "pendingStore" | "webSocket"> & {
  readonly lifecycle?: V3SyncClientOptions["lifecycle"];
  readonly pendingStore?: V3SyncClientOptions["pendingStore"];
  readonly webSocket?: V3SyncClientOptions["webSocket"];
  readonly persistenceScope?: string;
  readonly indexedDb?: Omit<IndexedDbV3PendingTargetStoreOptions, "scope">;
};

export function createV3SyncClient(options: CreateV3SyncClientOptions): V3SyncClient {
  const { indexedDb, lifecycle, mediaPlane, pendingStore, persistenceScope, webSocket, ...clientOptions } = options;
  return new V3SyncClient({
    ...clientOptions,
    lifecycle: lifecycle ?? createBrowserSyncLifecycle(),
    mediaPlane,
    pendingStore: pendingStore ?? (persistenceScope ? new IndexedDbV3PendingTargetStore({ ...indexedDb, scope: persistenceScope }) : undefined),
    webSocket: webSocket ?? createBrowserWebSocketFactory(),
  });
}
