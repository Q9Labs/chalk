import { encodePresentingFrame } from "./codec";
import type { components } from "../generated/presenting-v1";
import type { PresentingCommandResult, PresentingDocument, PresentingReplicaSnapshot } from "./types";

type Wire = components["schemas"];
type Pending = {
  readonly wire: string;
  readonly resolve: (result: PresentingCommandResult) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
};
const unknownResult = { kind: "delivery_unknown" } as const;
const unavailable = { kind: "unavailable" } as const;

export class PresentingReplica {
  readonly #send: (wire: string) => boolean;
  readonly #listeners = new Set<() => void>();
  readonly #pending = new Map<string, Pending>();
  #snapshot: PresentingReplicaSnapshot = { status: "connecting" };
  #live = false;
  #available = false;

  constructor(send: (wire: string) => boolean) {
    this.#send = send;
  }

  getSnapshot = (): PresentingReplicaSnapshot => this.#snapshot;
  get available(): boolean {
    return this.#available;
  }
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  enterLive(negotiated: boolean): void {
    this.#live = negotiated;
    this.#available = negotiated;
    if (negotiated) {
      this.#set({ status: "connecting" });
      if (!this.#send(JSON.stringify({ type: "presenting_state_request" }))) {
        this.#available = false;
        this.#set({ status: "unavailable" });
      }
    } else {
      this.#reset("unavailable", true);
    }
  }

  disconnected(terminal = false): void {
    this.#live = false;
    this.#available = false;
    this.#reset(terminal ? "unavailable" : "connecting", terminal);
  }

  receive(frame: Wire["ServerFrame"]): void {
    if (!this.#live) return;
    switch (frame.type) {
      case "presenting_state":
        this.#available = frame.state !== null;
        this.#set(frame.state ? { status: "ready", revision: frame.state.revision, documents: frame.state.documents.map(document) } : { status: "unavailable" });
        return;
      case "presenting_changed":
        this.#available = true;
        this.#set({ status: "ready", revision: frame.state.revision, documents: frame.state.documents.map(document) });
        return;
      case "presenting_receipt":
        this.#settle(frame.operation_id, frame.result);
    }
  }

  present(documentId: string): Promise<PresentingCommandResult> {
    return this.#command({ kind: "present", document_id: documentId });
  }
  setPage(documentId: string, page: number): Promise<PresentingCommandResult> {
    return this.#command({ kind: "set_state", document_id: documentId, page });
  }
  setZoom(documentId: string, zoom: number): Promise<PresentingCommandResult> {
    return this.#command({ kind: "set_state", document_id: documentId, zoom });
  }
  stop(documentId: string): Promise<PresentingCommandResult> {
    return this.#command({ kind: "stop", document_id: documentId });
  }

  #command(command: Wire["Command"]): Promise<PresentingCommandResult> {
    if (!this.#live || this.#snapshot.status === "unavailable") return Promise.resolve(unavailable);
    const operationId = uuidV7(Date.now());
    const wire = encodePresentingFrame({ type: "presenting_command", operation_id: operationId, command });
    return new Promise((resolve) => {
      this.#pending.set(operationId, { wire, resolve, timeout: setTimeout(() => this.#settle(operationId, unknownResult), 10_000) });
      if (!this.#send(wire)) this.#settle(operationId, unknownResult);
    });
  }

  #settle(operationId: string, result: PresentingCommandResult): void {
    const pending = this.#pending.get(operationId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.#pending.delete(operationId);
    pending.resolve(result);
  }

  #reset(status: "connecting" | "unavailable", discard: boolean): void {
    if (discard) for (const id of this.#pending.keys()) this.#settle(id, unknownResult);
    this.#set({ status });
  }

  #set(snapshot: PresentingReplicaSnapshot): void {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }
}

function document(input: Wire["Document"]): PresentingDocument {
  return { documentId: input.document_id, presenterId: input.presenter_id, page: input.page, zoom: input.zoom, startedAtMs: input.started_at_ms };
}

function uuidV7(timeMs: number): string {
  const nonce = crypto.randomUUID();
  const timestamp = timeMs.toString(16).padStart(12, "0");
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7${nonce.slice(15)}`;
}
