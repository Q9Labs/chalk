/**
 * The entry path of C3: pre-admission and dashboard records are delivered to `POST /v1/public/entry`,
 * credential-free, because the client has no credential yet — that is the point of the path. sendBeacon
 * carries pagehide sends; fetch keepalive is the fallback. Records carry the client session's own `cs_`
 * source id and per-session `seq`, so the reader can order them and see drops.
 */
export type EntryKind = "fact" | "op" | "decision" | "surface" | "transition";

export type EntrySender = {
  fact(name: string, fields?: Record<string, unknown>): void;
  decision(name: string, decision: string, reasonCode: string | undefined, fields?: Record<string, unknown>): void;
  op(name: string, fields: Record<string, unknown>): EntryOpScope;
  transition(machine: string, from: string, to: string, trigger: string, fields?: Record<string, unknown>): void;
  surface(name: string, fields: Record<string, unknown>): { dismiss(): void };
};

export type EntryOpScope = {
  ok(fields?: Record<string, unknown>): void;
  expected(reasonCode: string, fields?: Record<string, unknown>): void;
  error(reasonCode?: string, fields?: Record<string, unknown>): void;
};

const entryPath = "/v1/public/entry";

const randomToken = (): string => {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID().replace(/-/g, "");
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
};

/** Mint or reuse the pre-auth `cs_`/`dev_` pair. sessionStorage keeps cs_ across a same-tab reload;
 * localStorage keeps dev_ across the device; a dev_ that only fits sessionStorage is ephemeral. */
export const mintEntryIds = (storage?: { session?: Storage; local?: Storage }): { cs: string; dev: string; ephemeral: boolean } => {
  const session = storage?.session ?? globalThis.sessionStorage;
  const local = storage?.local ?? globalThis.localStorage;
  let cs: string | null = null;
  let dev: string | null = null;
  try {
    cs = session?.getItem("chalk.cs") ?? null;
  } catch {
    cs = null;
  }
  if (cs === null || !cs.startsWith("cs_")) {
    cs = `cs_${randomToken()}`;
    try {
      session?.setItem("chalk.cs", cs);
    } catch {
      /* kept in memory */
    }
  }
  let ephemeral = false;
  try {
    dev = local?.getItem("chalk.dev") ?? null;
  } catch {
    dev = null;
  }
  if (dev === null || !dev.startsWith("dev_")) {
    dev = `dev_${randomToken()}`;
    try {
      local?.setItem("chalk.dev", dev);
    } catch {
      ephemeral = true;
      try {
        session?.setItem("chalk.dev", dev);
      } catch {
        /* kept in memory */
      }
    }
  }
  return { cs, dev, ephemeral };
};

export type EntrySenderOptions = {
  baseUrl: string;
  cs: string;
  dev: string;
  ephemeral?: boolean;
  buildId?: string;
  journeyId?: string;
  onError?: (error: unknown) => void;
};

export function createEntrySender(options: EntrySenderOptions): EntrySender {
  let seq = 0;
  const url = `${options.baseUrl.replace(/\/$/, "")}${entryPath}`;
  const envelope = (events: Array<{ kind: EntryKind; name: string; fields: Record<string, unknown> }>) => {
    const now = Date.now();
    const body = JSON.stringify({
      v: 1,
      client_session_id: options.cs,
      device_id: options.dev,
      ephemeral_device: options.ephemeral ?? false,
      ...(options.buildId !== undefined ? { build_id: options.buildId } : {}),
      ...(options.journeyId !== undefined ? { journey_id: options.journeyId } : {}),
      events: events.map(({ kind, name, fields }) => ({ kind, name, seq: ++seq, est_server_ms: now, fields })),
    });
    const sent =
      typeof globalThis.navigator?.sendBeacon === "function" &&
      globalThis.navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
    if (!sent) {
      try {
        void globalThis
          .fetch?.(url, { method: "POST", body, headers: { "content-type": "application/json" }, keepalive: true, credentials: "omit" })
          .catch((error: unknown) => options.onError?.(error));
      } catch (error) {
        options.onError?.(error);
      }
    }
  };
  const op = (name: string, fields: Record<string, unknown>): EntryOpScope => {
    const startedMs = Date.now();
    const end = (outcome: string, reasonCode: string | undefined, extra: Record<string, unknown> | undefined) =>
      envelope([
        {
          kind: "op",
          name,
          fields: { ...fields, ...extra, outcome, duration_ms: Date.now() - startedMs, ...(reasonCode !== undefined ? { reason_code: reasonCode } : {}) },
        },
      ]);
    return {
      ok: (extra) => end("ok", undefined, extra),
      expected: (reasonCode, extra) => end("expected", reasonCode, extra),
      error: (reasonCode, extra) => end("error", reasonCode ?? "unclassified", extra),
    };
  };
  return {
    fact: (name, fields = {}) => envelope([{ kind: "fact", name, fields }]),
    decision: (name, decision, reasonCode, fields = {}) =>
      envelope([{ kind: "decision", name, fields: { ...fields, decision, ...(reasonCode !== undefined ? { reason_code: reasonCode } : {}) } }]),
    op,
    transition: (machine, from, to, trigger, fields = {}) => envelope([{ kind: "transition", name: `${machine}_edge`, fields: { ...fields, from_state: from, to_state: to, trigger } }]),
    surface: (name, fields) => {
      const shownMs = Date.now();
      envelope([{ kind: "surface", name, fields: { ...fields, surface_state: "shown", shown_ms: shownMs } }]);
      return {
        dismiss: () => envelope([{ kind: "surface", name, fields: { ...fields, surface_state: "dismissed", shown_ms: shownMs, dismissed_ms: Date.now() } }]),
      };
    },
  };
}
