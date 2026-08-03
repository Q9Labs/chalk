import { createBrowserSyncLifecycle, createBrowserWebSocketFactory } from "./browser";
import { V1SyncClient } from "./v1-client";
import { IndexedDbV1PendingTargetStore, type IndexedDbV1PendingTargetStoreOptions } from "./v1-platform-persistence";
import type { V1SyncClientOptions } from "./v1-types";

export type CreateV1SyncClientOptions = Omit<V1SyncClientOptions, "lifecycle" | "pendingStore" | "webSocket"> & {
  readonly lifecycle?: V1SyncClientOptions["lifecycle"];
  readonly pendingStore?: V1SyncClientOptions["pendingStore"];
  readonly webSocket?: V1SyncClientOptions["webSocket"];
  readonly persistenceScope?: string;
  readonly indexedDb?: Omit<IndexedDbV1PendingTargetStoreOptions, "scope">;
};

export function createV1SyncClient(options: CreateV1SyncClientOptions): V1SyncClient {
  const { indexedDb, lifecycle, mediaPlane, pendingStore, persistenceScope, webSocket, ...clientOptions } = options;
  return new V1SyncClient({
    ...clientOptions,
    lifecycle: lifecycle ?? createBrowserSyncLifecycle(),
    mediaPlane,
    pendingStore: pendingStore ?? (persistenceScope ? new IndexedDbV1PendingTargetStore({ ...indexedDb, scope: persistenceScope }) : undefined),
    webSocket: webSocket ?? createBrowserWebSocketFactory(),
  });
}
