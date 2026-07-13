export type SyncLifecycleEvent = "online" | "offline" | "active" | "inactive";

export type SyncLifecycle = {
  readonly subscribe: (listener: (event: SyncLifecycleEvent) => void) => () => void;
};

export type SyncSocket = {
  onopen: (() => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: ((event: { readonly code: number }) => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export type SyncWebSocketFactory = {
  readonly connect: (url: string) => SyncSocket;
};

export type SyncClock = {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
};

export type SyncIdGenerator = {
  readonly next: () => string;
};
