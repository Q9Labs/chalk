import type { components } from "../generated/openapi-types";

import type { ObsRecord } from "../obs/kernel";

export type TelemetryRequest = components["schemas"]["TelemetryRequest"];
/** A record of the legacy vocabulary, named by `type` and checked by the API's own table. New telemetry is a kernel record instead. */
export type TelemetryEvent = TelemetryRequest["events"][number];
/** A kernel record as it leaves: the record the kernel made, with the seq the outbox gave it in its source. */
export type TelemetryRecord = ObsRecord & { readonly seq: number };
/** What one batch carries: kernel records and records of the legacy vocabulary, in one seq order. */
export type WireEvent = TelemetryEvent | TelemetryRecord;
/** The ledger frame as the outbox writes it: the API's request, with kernel records among its events. */
export type LedgerFrame = Omit<TelemetryRequest, "events"> & { readonly events: readonly WireEvent[] };
export type TelemetryEventType = TelemetryEvent["type"];
/** A half-open range `[from, to)` of seqs of one source. */
export type SeqRange = NonNullable<TelemetryEvent["dropped_seqs"]>[number];
export type DropReason = NonNullable<TelemetryEvent["drop_reason"]>;
export type SourceEnd = NonNullable<TelemetryRequest["end"]>;
/** What an observer says. The outbox adds `seq`, `event_id` and `elapsed_ms`. */
export type TelemetryDraft = Omit<TelemetryEvent, "seq" | "event_id" | "elapsed_ms">;
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

/** `retryAfterMs` is 0 when the response names no delay. `acks` is what a 2xx answer settled, and absent when the answer could not be read. `send` rejects when the request never got a response. */
/** `serverMs` is the server's clock as it answered, which the client clock estimate samples. */
export type TelemetrySendResult = { readonly status: number; readonly retryAfterMs: number; readonly acks?: readonly SeqRange[]; readonly serverMs?: number };

/** Where the outbox keeps what must outlive a reload, as one text per source. Every call is synchronous. `save` says whether the text was kept, and a journal that fails is no durability, never an error. */
export type TelemetryJournal = {
  readonly list: () => readonly string[];
  readonly load: (sourceId: string) => string | null;
  readonly save: (sourceId: string, text: string) => boolean;
  readonly remove: (sourceId: string) => void;
};

/** Everything the outbox needs from the runtime. The web and React Native packages each supply one, and the outbox never touches `window`. */
export type TelemetryPlatform = {
  /** Monotonic milliseconds. */
  readonly now: () => number;
  /** Wall-clock Unix milliseconds. Date.now when absent. */
  readonly wall?: () => number;
  readonly uuid: () => string;
  readonly online: () => boolean;
  readonly hidden: () => boolean;
  readonly subscribe: (listener: (change: PlatformChange) => void) => () => void;
  readonly send: (request: TelemetrySend) => Promise<TelemetrySendResult>;
  /** Absent where an app kill leaves nothing behind (React Native today): the outbox then has no durability across a reload. */
  readonly journal?: TelemetryJournal;
};

/** One step of the delivery model (docs/telemetry-delivery.md), reported as the code takes it. `end` is "" when the batch carries none. */
export type DeliveryStep =
  | { readonly a: "record"; readonly src: string; readonly seq: number; readonly p0: boolean }
  | { readonly a: "evict"; readonly src: string; readonly seq: number }
  | { readonly a: "emit_drop"; readonly src: string; readonly seq: number; readonly covers: readonly (readonly [string, number])[] }
  | { readonly a: "checkpoint"; readonly src: string; readonly next: number }
  | { readonly a: "send"; readonly src: string; readonly batch: string; readonly seqs: readonly number[]; readonly next: number; readonly end: SourceEnd | "" }
  | { readonly a: "timeout"; readonly src: string; readonly batch: string }
  | { readonly a: "ack"; readonly src: string; readonly batch: string; readonly acks: readonly number[] }
  | { readonly a: "pagehide" }
  | { readonly a: "dispose"; readonly src: string }
  | { readonly a: "reboot"; readonly src: string }
  | { readonly a: "rejoin"; readonly src: string; readonly next: string }
  | { readonly a: "abandon"; readonly src: string };

/** A media operation the person or the call asked for. `op_id` is the id the Sync frame carries when there is one, and a fresh UUID otherwise. */
export type MediaOperationStart = Pick<TelemetryEvent, "action" | "source"> & { readonly op_id?: string };
export type MediaOperationResult = Pick<TelemetryEvent, "code" | "media_error_kind" | "http_status"> & { readonly outcome: "succeeded" | "failed" | "cancelled" };

/** What observers hold: they say what happened and nothing else. */
export type TelemetrySink = {
  readonly record: (draft: TelemetryDraft) => void;
  /** Records `media_intent` now. The returned function records the matching `media_result` once, with the time since the intent. */
  readonly operation: (start: MediaOperationStart) => (result: MediaOperationResult) => void;
  /** What stopped the platform, if anything did, in the last `withinMs` milliseconds. */
  readonly interruption: (withinMs: number) => "offline" | "hidden" | null;
};
