import type { ConnectionPorts } from "../connection";
import { confirmedScreenPublication } from "../space-client/media-snapshot";
import type { ScreenAnnotationClient, ScreenAnnotationCommand, ScreenAnnotationCursor, ScreenAnnotationDraft, ScreenAnnotationFrameSize, ScreenAnnotationSnapshot, ScreenAnnotationTarget } from "./index";
import type { AnnotationReplica } from "./replica";

type AnnotationPorts = {
  readonly sync: Pick<ConnectionPorts["sync"], "annotation" | "getSnapshot" | "subscribe">;
  readonly media: Pick<ConnectionPorts["media"], "getSnapshot" | "subscribe">;
};

const unavailable: ScreenAnnotationSnapshot = { status: "unavailable" };

/** Stable SpaceClient facade. Replacing the Sync port abandons all connection-local state. */
export class AnnotationSession implements ScreenAnnotationClient {
  readonly #listeners = new Set<() => void>();
  #replica: AnnotationReplica | undefined;
  #unbind: (() => void) | undefined;
  readonly #unsubscribePorts: () => void;

  constructor(
    connection: { readonly subscribePorts: (listener: (ports: AnnotationPorts | null) => void) => () => void },
    private readonly verifiedCapture?: (track: MediaStreamTrack) => ScreenAnnotationFrameSize | undefined,
  ) {
    this.#unsubscribePorts = connection.subscribePorts((ports) => this.#bind(ports));
  }

  supportsBurnIn = (): boolean => this.#replica?.burnInNegotiated === true;
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

  #bind(ports: AnnotationPorts | null): void {
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
      const local = localScreenBinding(ports, replica.getSnapshot(), replica.burnInNegotiated ? this.verifiedCapture : undefined);
      if (local.kind === "unavailable") return;
      if (local.kind === "waiting_for_dimensions") {
        schedule();
        return;
      }

      binding = true;
      void replica.bind(local.publicationId, local.frame, local.burnedIn).finally(() => {
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

function localScreenBinding(ports: AnnotationPorts, annotation: ScreenAnnotationSnapshot, verifiedCapture?: (track: MediaStreamTrack) => ScreenAnnotationFrameSize | undefined) {
  if (annotation.status !== "ready") return { kind: "unavailable" } as const;
  const sync = ports.sync.getSnapshot();
  const screen = ports.media.getSnapshot().localTracks.find((track) => track.source === "screen" && track.enabled);
  // Wait for Sync to observe this exact locally published track.
  const publicationId = confirmedScreenPublication(screen, sync);
  if (!screen || !publicationId || annotation.state?.layer.publication_id === publicationId) return { kind: "unavailable" } as const;
  const witness = verifiedCapture?.(screen.track);
  const frame = witness ?? screenDimensions(screen.track);
  return frame ? ({ kind: "ready", publicationId, frame, burnedIn: witness !== undefined } as const) : ({ kind: "waiting_for_dimensions" } as const);
}

function screenDimensions(track: MediaStreamTrack) {
  const { width, height } = track.getSettings?.() ?? {};
  return width && height ? { width, height } : null;
}
