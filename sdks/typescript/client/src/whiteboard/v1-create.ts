import { createBrowserSyncLifecycle, createBrowserWebSocketFactory } from "../sync/browser";
import { ChalkWhiteboardV1Client } from "./v1-client";
import type { ChalkWhiteboardV1ClientOptions } from "./types";

export type CreateChalkWhiteboardV1ClientOptions = Omit<ChalkWhiteboardV1ClientOptions, "lifecycle" | "webSocket"> & {
  readonly lifecycle?: ChalkWhiteboardV1ClientOptions["lifecycle"];
  readonly webSocket?: ChalkWhiteboardV1ClientOptions["webSocket"];
};

export function createChalkWhiteboardV1Client(options: CreateChalkWhiteboardV1ClientOptions): ChalkWhiteboardV1Client {
  return new ChalkWhiteboardV1Client({
    ...options,
    lifecycle: options.lifecycle ?? {
      subscribe: (listener) => createBrowserSyncLifecycle().subscribe(listener),
    },
    webSocket: options.webSocket ?? createBrowserWebSocketFactory(),
  });
}
