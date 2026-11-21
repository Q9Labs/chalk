import type { ConnectionPorts } from "../connection";
import type { ConnectionLifecycleCapability } from "../connection/lifecycle";
import { confirmedScreenPublication } from "../space-client/media-snapshot";
import type { ScreenAnnotationClient, ScreenAnnotationCommand, ScreenAnnotationCursor, ScreenAnnotationDraft, ScreenAnnotationSnapshot, ScreenAnnotationTarget } from "./index";
import type { AnnotationReplica } from "./replica";

const unavailable: ScreenAnnotationSnapshot = { status: "unavailable" };

/** Stable SpaceClient facade. Replacing the Sync port abandons all connection-local state. */
export class AnnotationSession implements ScreenAnnotationClient {
  readonly #listeners = new Set<() => void>();
  #replica: AnnotationReplica | undefined;
  #unbind: (() => void) | undefined;
  readonly #unsubscribePorts: () => void;

  constructor(connection: ConnectionLifecycleCapability) {
    this.#unsubscribePorts = connection.subscribePorts((ports) => this.#bind(ports));
  }

  getSnapshot = () => this.#replica?.getSnapshot() ?? unavailable;
  serverNowMs = () => this.#replica?.serverNowMs() ?? Date.now();
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  dispatch = (target: ScreenAnnotationTarget, command: ScreenAnnotationCommand) => this.#replica?.dispatch(target, command) ?? Promise.resolve({ kind: "unavailable" } as const);
  setPresence = (target: ScreenAnnotationTarget, cursor: ScreenAnnotationCursor | null, draft: ScreenAnnotationDraft | null) => this.#replica?.setPresence(target, cursor, draft);

  dispose(): void {
    this.#unsubscribePorts();
    this.#bind(null);
    this.#listeners.clear();
  }

  #bind(ports: ConnectionPorts | null): void {
    this.#unbind?.();
    const replica = ports?.sync.annotation;
    this.#replica = replica;
    this.#emit();
    if (!ports || !replica) return;

    let retry: ReturnType<typeof setTimeout> | undefined;
    let binding = false;
    let disposed = false;
    const bindLocal = () => {
      if (disposed || binding || retry !== undefined) return;
      const annotation = replica.getSnapshot();
      if (annotation.status !== "ready") return;

      const sync = ports.sync.getSnapshot();
      const screen = ports.media.getSnapshot().localTracks.find((track) => track.source === "screen" && track.enabled);
      // Wait for Sync to observe this exact locally published track.
      const publicationId = confirmedScreenPublication(screen, sync);
      if (!screen || !publicationId || annotation.state?.layer.publication_id === publicationId) return;
      const { width, height } = screen.track.getSettings?.() ?? {};
      if (!width || !height) {
        schedule();
        return;
      }

      binding = true;
      void replica.bind(publicationId, { width, height }).finally(() => {
        binding = false;
        if (!disposed) schedule();
      });
    };
    const schedule = () => {
      retry = setTimeout(() => {
        retry = undefined;
        bindLocal();
      }, 1_000);
    };

    const unsubscribers = [
      replica.subscribe(() => {
        this.#emit();
        bindLocal();
      }),
      ports.sync.subscribe(bindLocal),
      ports.media.subscribe(bindLocal),
    ];

    this.#unbind = () => {
      disposed = true;
      clearTimeout(retry);
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
    bindLocal();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}
