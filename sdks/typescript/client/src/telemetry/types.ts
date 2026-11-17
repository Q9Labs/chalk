import type { components } from "../generated/openapi-types";

export type TelemetryRequest = components["schemas"]["TelemetryRequest"];
export type TelemetryEvent = TelemetryRequest["events"][number];
/** What an observer says. The outbox adds `seq` and `elapsed_ms`. */
export type TelemetryDraft = Omit<TelemetryEvent, "seq" | "elapsed_ms">;
export type TelemetryStats = NonNullable<TelemetryEvent["stats"]>;
export type PlatformState = NonNullable<TelemetryEvent["platform_state"]>;
/** What the platform tells the outbox. `closing` is the page going away, which no later event can follow. */
export type PlatformChange = PlatformState | "closing";

/** The participant media credential. The server accepts it until it expires, even after the participant left. */
export type TelemetryCredential = {
  readonly tenantId: string;
  /** Names who the credential speaks for (tenant, Episode and participant). An event leaves only under the credential of the subject it was recorded for. */
  readonly subject: string;
  readonly token: string;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
};

/** Where the outbox reads the credential at send time, and how it asks for a fresh one. */
export type TelemetryCredentialSource = {
  readonly current: () => TelemetryCredential | null;
  readonly refresh: () => Promise<void>;
};

export type TelemetrySend = {
  readonly url: string;
  readonly token: string;
  readonly traceparent: string;
  readonly body: string;
  readonly keepalive: boolean;
  readonly signal: AbortSignal;
};

/** `retryAfterMs` is 0 when the response names no delay. `send` rejects when the request never got a response. */
export type TelemetrySendResult = { readonly status: number; readonly retryAfterMs: number };

/** Everything the outbox needs from the runtime. The web and React Native packages each supply one, and the outbox never touches `window`. */
export type TelemetryPlatform = {
  /** Monotonic milliseconds. */
  readonly now: () => number;
  readonly uuid: () => string;
  readonly online: () => boolean;
  readonly hidden: () => boolean;
  readonly subscribe: (listener: (change: PlatformChange) => void) => () => void;
  readonly send: (request: TelemetrySend) => Promise<TelemetrySendResult>;
};

/** What observers hold: they say what happened and nothing else. */
export type TelemetrySink = {
  readonly record: (draft: TelemetryDraft) => void;
  /** What stopped the platform, if anything did, in the last `withinMs` milliseconds. */
  readonly interruption: (withinMs: number) => "offline" | "hidden" | null;
};
