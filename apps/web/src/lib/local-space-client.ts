import type { GetAccess, SpaceClient, SpaceClientOptions } from "@q9labsai/chalk-client";
import { createSpaceClientForPlatform, type SpaceClientPlatform } from "@q9labsai/chalk-client/effect";
import type { TelemetryJourney } from "@q9labsai/chalk-client/telemetry";

import type { DashboardSpaceCredential, ParticipantCredential } from "./chalk-access";

const localSpace = "local-space";

type SpaceOperationJourney = Pick<TelemetryJourney, "recordDiagnostic"> & { readonly context?: TelemetryJourney["context"] };
type CreateSpaceClient = (options: SpaceClientOptions, platform: SpaceClientPlatform) => SpaceClient;

export type LocalSpaceClientOptions = {
  readonly credential: ParticipantCredential | DashboardSpaceCredential;
  readonly getAccess: GetAccess;
  readonly connectionAccess?: SpaceClientPlatform["connectionAccess"];
  readonly journey: SpaceOperationJourney;
};

type LocalSpaceClientDependencies = {
  readonly createSpaceClient?: CreateSpaceClient;
  readonly now?: () => number;
};

/** Creates the app-owned public client so its broker-selected API and sync endpoints stay paired. */
export function createLocalSpaceClient({ credential, getAccess, connectionAccess, journey }: LocalSpaceClientOptions, dependencies: LocalSpaceClientDependencies = {}): SpaceClient {
  const dashboard = "space" in credential;
  const syncURL = "syncURL" in credential ? credential.syncURL : undefined;
  const client = (dependencies.createSpaceClient ?? createSpaceClientForPlatform)(
    { space: dashboard ? credential.space : localSpace, getAccess, baseUrl: credential.apiBaseURL },
    { ...(syncURL ? { syncUrl: syncURL } : {}), ...(connectionAccess ? { connectionAccess } : {}), telemetry: journey.context },
  );
  return instrumentSpaceClient(client, journey, dependencies.now ?? Date.now);
}

/** Releasing is safe from both the public client's leave callback and React unmount cleanup. */
export function createLocalSpaceRelease(client: Pick<SpaceClient, "leave" | "dispose">, cleanup: () => Promise<void>): () => Promise<void> {
  let releasePromise: Promise<void> | undefined;

  return () => {
    if (releasePromise) return releasePromise;
    releasePromise = releaseOnce(client, cleanup).catch((cause: unknown) => {
      releasePromise = undefined;
      throw cause;
    });
    return releasePromise;
  };
}

async function releaseOnce(client: Pick<SpaceClient, "leave" | "dispose">, cleanup: () => Promise<void>): Promise<void> {
  try {
    await client.leave();
  } catch {
    // The broker credential still has to be cleared when transport shutdown is already in progress.
  }
  try {
    client.dispose();
  } catch {
    // Cleanup remains authoritative when the SDK disposal hook is already closed.
  }
  await cleanup();
}

function instrumentSpaceClient(client: SpaceClient, journey: SpaceOperationJourney, now: () => number): SpaceClient {
  const proxies = new WeakMap<object, object>();

  const wrap = <T extends object>(target: T, prefix = ""): T => {
    const existing = proxies.get(target);
    if (existing) return existing as T;

    const proxy = new Proxy(target, {
      get(current, property) {
        const value = Reflect.get(current, property, current);
        const operation = prefix ? `${prefix}.${String(property)}` : String(property);
        if (typeof value === "function") {
          if (!isSpaceOperation(operation)) return value.bind(current);
          return (...args: readonly unknown[]) => observeSpaceOperation(journey, operation, now, () => value.apply(current, args));
        }
        return value && typeof value === "object" ? wrap(value, operation) : value;
      },
    });
    proxies.set(target, proxy);
    return proxy;
  };

  return wrap(client);
}

function isSpaceOperation(operation: string): boolean {
  return operation === "join" || operation === "leave" || operation === "endEpisode" || operation === "extendEpisode" || operation.startsWith("media.") || operation.startsWith("chat.") || operation.startsWith("participants.") || operation.startsWith("reactions.");
}

function observeSpaceOperation<T>(journey: SpaceOperationJourney, operation: string, now: () => number, action: () => T): T {
  const startedAt = now();
  try {
    const result = action();
    if (!isPromiseLike(result)) {
      recordOperation(journey, operation, "succeeded", now() - startedAt);
      return result;
    }
    return result.then(
      (value) => {
        recordOperation(journey, operation, "succeeded", now() - startedAt);
        return value;
      },
      (cause: unknown) => {
        recordOperation(journey, operation, "failed", now() - startedAt);
        throw cause;
      },
    ) as T;
  } catch (cause) {
    recordOperation(journey, operation, "failed", now() - startedAt);
    throw cause;
  }
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return typeof value === "object" && value !== null && "then" in value && typeof value.then === "function";
}

function recordOperation(journey: SpaceOperationJourney, operation: string, state: "succeeded" | "failed", durationMs: number): void {
  journey.recordDiagnostic({
    category: "connection",
    code: "space.client_operation",
    phase: operation.startsWith("media.") ? "media" : "signaling",
    state,
    attributes: { operation, duration_ms: Math.max(0, Math.round(durationMs)) },
  });
}
