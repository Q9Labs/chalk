import { Effect } from "effect";
import type { ConnectionLifecycleCapability, ConnectionPorts } from "../connection";
import type { PresentingReplica } from "../presenting/replica";
import type { PresentingCommandResult, PresentingDocumentManifest, PresentingSlice } from "../presenting/types";
import * as apiUrls from "../api-urls";
import { withRequestContext } from "../session";
import { SpaceStore } from "./store";
import { foreign, normalizeClientError, type ClientEffect } from "./errors";

export type PresentingControllerEffects = {
  readonly present: (attachmentId: string) => ClientEffect<PresentingCommandResult>;
  readonly setPage: (documentId: string, page: number) => ClientEffect<PresentingCommandResult>;
  readonly setZoom: (documentId: string, zoom: number) => ClientEffect<PresentingCommandResult>;
  readonly stop: (documentId: string) => ClientEffect<PresentingCommandResult>;
  readonly manifest: (documentId: string) => ClientEffect<PresentingDocumentManifest>;
  readonly zoomUrl: (documentId: string, page: number) => ClientEffect<string>;
  readonly dispose: () => void;
};

/** Owns the negotiated Sync replica and refreshes the short-lived renderer manifests beside it. */
export const makePresentingController = (input: { readonly connection: ConnectionLifecycleCapability; readonly store: SpaceStore; readonly apiBaseUrl: string; readonly fetch?: typeof globalThis.fetch }): Effect.Effect<PresentingControllerEffects, never, import("effect").Scope.Scope> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<never>();
    const controller = new PresentingControllerRuntime(input.connection, input.store, input.apiBaseUrl, withRequestContext(input.fetch), () => Effect.runPromiseWith(context)(input.connection.getSyncToken()));
    yield* Effect.addFinalizer(() => Effect.sync(() => controller.dispose()));
    return controller;
  });

class PresentingControllerRuntime implements PresentingControllerEffects {
  readonly #apiBaseUrl: string;
  readonly #connection: ConnectionLifecycleCapability;
  readonly #fetch: typeof globalThis.fetch;
  readonly #store: SpaceStore;
  readonly #token: () => Promise<string>;
  readonly #manifests = new Map<string, PresentingDocumentManifest>();
  readonly #refreshes = new Map<string, ReturnType<typeof setTimeout>>();
  #documents: PresentingSlice["documents"] = Object.freeze([]);
  #replica: PresentingReplica | null = null;
  #revision = 0;
  #status: PresentingSlice["status"] = "connecting";
  #available = false;
  #unsubscribeConnection: (() => void) | null = null;
  #unsubscribeReplica: (() => void) | null = null;

  constructor(connection: ConnectionLifecycleCapability, store: SpaceStore, apiBaseUrl: string, fetchImplementation: typeof globalThis.fetch, token: () => Promise<string>) {
    this.#connection = connection;
    this.#store = store;
    this.#apiBaseUrl = apiBaseUrl;
    this.#fetch = fetchImplementation;
    this.#token = token;
    this.#unsubscribeConnection = connection.subscribePorts((ports) => this.#bind(ports));
    this.#publish();
  }

  present = (attachmentId: string): ClientEffect<PresentingCommandResult> =>
    this.#connection
      .runCommand(({ sync }) =>
        foreign(async () => {
          const created = await this.#request<{ readonly documentId: string; readonly status: string }>(apiUrls.presentingDocuments(this.#apiBaseUrl), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ attachmentId }) });
          return sync.presenting ? await sync.presenting.present(created.documentId) : ({ kind: "unavailable" } as const);
        }),
      )
      .pipe(Effect.mapError(normalizeClientError));

  setPage = (documentId: string, page: number): ClientEffect<PresentingCommandResult> => this.#syncCommand((replica) => replica.setPage(documentId, page));
  setZoom = (documentId: string, zoom: number): ClientEffect<PresentingCommandResult> => this.#syncCommand((replica) => replica.setZoom(documentId, zoom));
  stop = (documentId: string): ClientEffect<PresentingCommandResult> => this.#syncCommand((replica) => replica.stop(documentId));

  manifest = (documentId: string): ClientEffect<PresentingDocumentManifest> => foreign(() => this.#fetchManifest(documentId)).pipe(Effect.mapError(normalizeClientError));

  zoomUrl = (documentId: string, page: number): ClientEffect<string> =>
    foreign(async () => {
      const value = await this.#request<unknown>(apiUrls.presentingDocumentPageZoom(this.#apiBaseUrl, documentId, page), { method: "GET" });
      if (typeof value === "object" && value !== null && "imageUrl" in value && typeof value.imageUrl === "string") return value.imageUrl;
      if (typeof value === "object" && value !== null && "url" in value && typeof value.url === "string") return value.url;
      throw new Error("Presenting zoom service returned an invalid response");
    }).pipe(Effect.mapError(normalizeClientError));

  dispose(): void {
    this.#unsubscribeConnection?.();
    this.#unsubscribeConnection = null;
    this.#bind(null);
    for (const timer of this.#refreshes.values()) clearTimeout(timer);
    this.#refreshes.clear();
  }

  #syncCommand(operation: (replica: PresentingReplica) => Promise<PresentingCommandResult>): ClientEffect<PresentingCommandResult> {
    return this.#connection.runCommand(({ sync }) => foreign(() => (sync.presenting ? operation(sync.presenting) : Promise.resolve({ kind: "unavailable" } as const)))).pipe(Effect.mapError(normalizeClientError));
  }

  #bind(ports: ConnectionPorts | null): void {
    this.#unsubscribeReplica?.();
    this.#unsubscribeReplica = null;
    this.#replica = ports?.sync.presenting ?? null;
    if (this.#replica) {
      this.#unsubscribeReplica = this.#replica.subscribe(() => this.#observe());
      this.#observe();
    } else {
      this.#status = "connecting";
      this.#available = false;
      this.#revision = 0;
      this.#documents = Object.freeze([]);
      this.#manifests.clear();
      this.#publish();
    }
  }

  #observe(): void {
    const snapshot = this.#replica?.getSnapshot();
    if (!snapshot) return;
    this.#status = snapshot.status;
    this.#available = this.#replica?.available === true;
    this.#revision = snapshot.status === "ready" ? snapshot.revision : 0;
    this.#documents = snapshot.status === "ready" ? Object.freeze([...snapshot.documents]) : Object.freeze([]);
    const active = new Set(this.#documents.map((document) => document.documentId));
    for (const id of [...this.#manifests.keys()]) {
      if (!active.has(id)) {
        this.#manifests.delete(id);
        const timer = this.#refreshes.get(id);
        if (timer) clearTimeout(timer);
        this.#refreshes.delete(id);
      }
    }
    for (const document of this.#documents) void this.#ensureManifest(document.documentId);
    this.#publish();
  }

  async #ensureManifest(documentId: string): Promise<void> {
    if (this.#refreshes.has(documentId) && this.#manifests.has(documentId)) return;
    try {
      const manifest = await this.#fetchManifest(documentId);
      this.#manifests.set(documentId, manifest);
      this.#scheduleRefresh(documentId, manifest);
      this.#publish();
    } catch {
      this.#scheduleRefresh(documentId, null, 15_000);
    }
  }

  async #fetchManifest(documentId: string): Promise<PresentingDocumentManifest> {
    const value = await this.#request<unknown>(apiUrls.presentingDocument(this.#apiBaseUrl, documentId), { method: "GET" });
    if (!isManifest(value)) throw new Error("Presenting service returned an invalid document manifest");
    return Object.freeze({ ...value, pages: Object.freeze(value.pages.map((page) => Object.freeze({ ...page }))) });
  }

  async #request<T>(url: string, init: RequestInit): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${await this.#token()}`);
    const response = await this.#fetch(url, { ...init, headers });
    if (!response.ok) throw new Error(`Presenting request failed with HTTP ${response.status}`);
    return (await response.json()) as T;
  }

  #scheduleRefresh(documentId: string, manifest: PresentingDocumentManifest | null, minimumMs = 1_500): void {
    const existing = this.#refreshes.get(documentId);
    if (existing) clearTimeout(existing);
    const delay = manifest?.status === "preparing" ? 1_500 : (refreshDelay(manifest) ?? 4 * 60_000);
    this.#refreshes.set(
      documentId,
      setTimeout(
        () => {
          this.#refreshes.delete(documentId);
          void this.#ensureManifest(documentId);
        },
        Math.max(minimumMs, delay),
      ),
    );
  }

  #publish(): void {
    const manifests = Object.freeze(Object.fromEntries(this.#manifests));
    this.#store.update("presenting", Object.freeze({ status: this.#status, available: this.#available, revision: this.#revision, documents: this.#documents, manifests }));
  }
}

const MANIFEST_STATUSES: ReadonlySet<unknown> = new Set(["preparing", "ready", "failed"]);

function isManifest(value: unknown): value is PresentingDocumentManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const manifest = value as Record<string, unknown>;
  return hasManifestIdentity(manifest) && MANIFEST_STATUSES.has(manifest.status) && Array.isArray(manifest.pages);
}

function hasManifestIdentity(manifest: Record<string, unknown>): boolean {
  return typeof manifest.documentId === "string" && typeof manifest.attachmentId === "string" && typeof manifest.fileName === "string";
}

function refreshDelay(manifest: PresentingDocumentManifest | null): number | null {
  if (!manifest) return null;
  const expiries = manifest.pages.flatMap((page) => [urlExpiry(page.imageUrl), urlExpiry(page.thumbnailUrl)]).filter((value): value is number => value !== null);
  if (expiries.length === 0) return null;
  return Math.max(1_000, Math.min(...expiries) - Date.now() - 60_000);
}

function urlExpiry(value: string | undefined): number | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const amazonSeconds = url.searchParams.get("X-Amz-Expires");
    return amazonSeconds ? amazonExpiry(url, amazonSeconds) : queryExpiry(url);
  } catch {
    return null;
  }
}

function amazonExpiry(url: URL, amazonSeconds: string): number | null {
  const seconds = Number(amazonSeconds);
  const signedAt = amazonSigningTime(url.searchParams.get("X-Amz-Date"));
  return Number.isFinite(seconds) && signedAt !== null ? signedAt + seconds * 1_000 : null;
}

function queryExpiry(url: URL): number | null {
  for (const key of ["expires", "Expires", "exp"]) {
    const raw = url.searchParams.get(key);
    if (!raw) continue;
    const number = Number(raw);
    if (!Number.isFinite(number)) continue;
    return number < 10_000_000_000 ? number * 1_000 : number;
  }
  return null;
}

function amazonSigningTime(value: string | null): number | null {
  const match = value ? /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value) : null;
  if (!match) return null;
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
  return Number.isFinite(time) ? time : null;
}
