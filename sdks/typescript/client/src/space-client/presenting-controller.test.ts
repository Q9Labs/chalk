import { Effect } from "effect";
import { expect, it, vi } from "vitest";

import type { ConnectionLifecycleCapability, ConnectionPorts } from "../connection";
import type { PresentingReplica } from "../presenting/replica";
import { makePresentingController } from "./presenting-controller";
import { SpaceStore } from "./store";

const documentId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c21";
const presenterId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c22";

function harness(options: { readonly fetch: typeof globalThis.fetch; readonly replica?: Partial<PresentingReplica> }) {
  // A fake replica with inspectable state: tests read what presenting left behind rather than intercepting calls.
  const presented: string[] = [];
  const replica = {
    getSnapshot: () => ({ status: "ready", revision: 1, documents: [{ documentId, presenterId, page: 1, zoom: 100, startedAtMs: 5 }] }),
    subscribe: () => () => undefined,
    present: async (document: string) => {
      presented.push(document);
      return { kind: "accepted", revision: 2 } as const;
    },
    setPage: async () => ({ kind: "accepted", revision: 3 }) as const,
    stop: async () => ({ kind: "accepted", revision: 4 }) as const,
    ...options.replica,
  } as unknown as PresentingReplica;
  const ports = { sync: { presenting: replica } } as unknown as ConnectionPorts;
  const connection = {
    subscribePorts: (listener: (ports: ConnectionPorts | null) => void) => {
      listener(ports);
      return () => undefined;
    },
    runCommand: <A, E>(operation: (ports: ConnectionPorts) => Effect.Effect<A, E>) => operation(ports),
    getSyncToken: () => Effect.succeed("token"),
  } as unknown as ConnectionLifecycleCapability;
  return { connection, replica, presented, store: new SpaceStore() };
}

const manifest = {
  documentId,
  attachmentId: "attachment-1",
  fileName: "deck.pdf",
  status: "ready",
  pageCount: 2,
  pages: [
    { page: 1, width: 1600, height: 900, status: "ready", imageUrl: "https://cdn.example/p1.png?expires=9999999999" },
    { page: 2, width: 1600, height: 900, status: "pending" },
  ],
};

function fetchWith(routes: Record<string, unknown>): typeof globalThis.fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [suffix, body] of Object.entries(routes)) {
      if (url.endsWith(suffix)) return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof globalThis.fetch;
}

it("creates the renderer document then presents it through sync", async () => {
  const requests: string[] = [];
  const baseFetch = fetchWith({ "/v1/presenting/documents": { documentId, status: "preparing" }, [`/v1/presenting/documents/${documentId}`]: manifest });
  const recordingFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(`${init?.method ?? "GET"} ${String(input)}`);
    return baseFetch(input, init);
  }) as typeof globalThis.fetch;
  const { connection, presented, store } = harness({ fetch: recordingFetch });

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const controller = yield* makePresentingController({ connection, store, apiBaseUrl: "https://api.example", fetch: recordingFetch });
        const result = yield* controller.present("attachment-1");
        expect(result).toEqual({ kind: "accepted", revision: 2 });
        expect(presented).toEqual([documentId]);
        expect(requests).toContain("POST https://api.example/v1/presenting/documents");
      }),
    ),
  );
});

it("publishes replica documents and fetches their manifests into the store", async () => {
  const fetching = fetchWith({ [`/v1/presenting/documents/${documentId}`]: manifest });
  const { connection, store } = harness({ fetch: fetching });

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const controller = yield* makePresentingController({ connection, store, apiBaseUrl: "https://api.example", fetch: fetching });
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)));
        const slice = store.getSnapshot().presenting;
        expect(slice.status).toBe("ready");
        expect(slice.documents).toMatchObject([{ documentId, page: 1 }]);
        expect(slice.manifests[documentId]).toMatchObject({ fileName: "deck.pdf", status: "ready" });
        expect(slice.manifests[documentId]?.pages[0]?.imageUrl).toContain("expires=9999999999");

        const fetched = yield* controller.manifest(documentId);
        expect(fetched.fileName).toBe("deck.pdf");
        controller.dispose();
      }),
    ),
  );
});

it("resolves zoom urls and reports unavailable without a negotiated replica", async () => {
  const fetching = fetchWith({ [`/v1/presenting/documents/${documentId}/pages/2/zoom`]: { imageUrl: "https://cdn.example/zoom.png", expiresAt: "x" } });
  const { connection, store } = harness({ fetch: fetching });

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const controller = yield* makePresentingController({ connection, store, apiBaseUrl: "https://api.example", fetch: fetching });
        expect(yield* controller.zoomUrl(documentId, 2)).toBe("https://cdn.example/zoom.png");
        controller.dispose();
      }),
    ),
  );

  const noReplica = { sync: {} } as unknown as ConnectionPorts;
  const deadConnection = {
    subscribePorts: (listener: (ports: ConnectionPorts | null) => void) => {
      listener(noReplica);
      return () => undefined;
    },
    runCommand: <A, E>(operation: (ports: ConnectionPorts) => Effect.Effect<A, E>) => operation(noReplica),
    getSyncToken: () => Effect.succeed("token"),
  } as unknown as ConnectionLifecycleCapability;
  const deadStore = new SpaceStore();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const controller = yield* makePresentingController({ connection: deadConnection, store: deadStore, apiBaseUrl: "https://api.example", fetch: fetching });
        expect(yield* controller.stop(documentId)).toEqual({ kind: "unavailable" });
        controller.dispose();
      }),
    ),
  );
});
