import type { TokenProvider } from "../types.ts";

export const defaultTimers = {
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  setInterval: globalThis.setInterval.bind(globalThis),
  clearInterval: globalThis.clearInterval.bind(globalThis),
};
export type Timers = typeof defaultTimers;

export type WebSocketFactory = (url: string, protocols: string[]) => WebSocket;

export const defaultWebSocketFactory: WebSocketFactory = (url, protocols) => new WebSocket(url, protocols);

export type WSClientOptions = {
  debug?: boolean;
  tokenProvider?: TokenProvider;
  webSocketFactory?: WebSocketFactory;
  timers?: Timers;
  now?: () => number;
};
