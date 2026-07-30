import type { WhiteboardCommit } from "../collab/wire.js";
import { CHALK_EMBEDDED_WHITEBOARD_BRIDGE_VERSION, CHALK_EMBEDDED_WHITEBOARD_EXCALIDRAW_VERSION, decodeEmbeddedWhiteboardHostMessage, encodeEmbeddedWhiteboardMessage, type ChalkEmbeddedWhiteboardHostEnvelope, type ChalkEmbeddedWhiteboardRendererMessage } from "./protocol.js";

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (message: string) => void };
  }
}

type PendingRequest = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

type HostListener = (message: ChalkEmbeddedWhiteboardHostEnvelope) => void;
const MAX_RECENT_MESSAGE_IDS = 2_048;

export class ChalkEmbeddedWhiteboardRendererBridge {
  readonly #context = rendererContext();
  readonly #listeners = new Set<HostListener>();
  readonly #pending = new Map<string, PendingRequest>();
  readonly #hostMessageIds = new Set<string>();
  #started = false;

  start(): void {
    if (this.#started) return;
    this.#started = true;
    window.addEventListener("message", this.#onMessage);
    document.addEventListener("message", this.#onDocumentMessage as EventListener);
    this.post({
      type: "ready",
      payload: {
        excalidrawVersion: CHALK_EMBEDDED_WHITEBOARD_EXCALIDRAW_VERSION,
        supportedBridgeVersions: [CHALK_EMBEDDED_WHITEBOARD_BRIDGE_VERSION],
      },
    });
  }

  dispose(): void {
    if (!this.#started) return;
    this.#started = false;
    window.removeEventListener("message", this.#onMessage);
    document.removeEventListener("message", this.#onDocumentMessage as EventListener);
    for (const request of this.#pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("embedded whiteboard renderer bridge closed"));
    }
    this.#pending.clear();
    this.#listeners.clear();
    this.#hostMessageIds.clear();
  }

  subscribe(listener: HostListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  post(message: ChalkEmbeddedWhiteboardRendererMessage): void {
    const webView = window.ReactNativeWebView;
    if (!webView) throw new Error("embedded whiteboard native bridge is unavailable");
    webView.postMessage(encodeEmbeddedWhiteboardMessage(message, this.#context));
  }

  submitUpdate(input: { readonly sceneId: string; readonly sceneGeneration?: string; readonly syncAll: boolean; readonly elements: readonly import("../collab/wire.js").WhiteboardWireElement[] }): Promise<WhiteboardCommit> {
    if (!input.sceneGeneration) return Promise.reject(new Error("embedded whiteboard scene generation is unavailable"));
    return this.#request<WhiteboardCommit>("local_update", input);
  }

  requestSnapshot(): Promise<void> {
    return this.#request<void>("request_snapshot", {});
  }

  clear(): Promise<WhiteboardCommit> {
    return this.#request<WhiteboardCommit>("clear", {});
  }

  uploadFile(input: { readonly fileId: string; readonly mimeType: string; readonly byteLength: number; readonly sha256: string; readonly dataURL: string }): Promise<void> {
    return this.#request<void>("file_write", input);
  }

  downloadFile(fileId: string): Promise<{ readonly mimeType: string; readonly dataURL: string }> {
    return this.#request("file_read", { fileId });
  }

  #request<T>(type: "local_update" | "request_snapshot" | "clear" | "file_write" | "file_read", payload: Record<string, unknown>): Promise<T> {
    const requestId = this.#context.nextMessageId();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error(`embedded whiteboard ${type} timed out`));
      }, 20_000);
      this.#pending.set(requestId, { resolve: (value) => resolve(value as T), reject, timer });
      this.post({ type, payload: { requestId, ...payload } } as ChalkEmbeddedWhiteboardRendererMessage);
    });
  }

  readonly #onMessage = (event: MessageEvent): void => {
    this.#receive(event.data);
  };

  readonly #onDocumentMessage = (event: MessageEvent): void => {
    this.#receive(event.data);
  };

  #receive(data: unknown): void {
    if (typeof data !== "string") return;
    let message: ChalkEmbeddedWhiteboardHostEnvelope;
    try {
      message = decodeEmbeddedWhiteboardHostMessage(data, this.#context.rendererGeneration);
      if (message.journeyId !== this.#context.journeyId) throw new Error("embedded whiteboard journey does not match");
      if (!recordMessageId(this.#hostMessageIds, message.messageId)) return;
    } catch (cause) {
      this.#reportError("invalid_host_message", cause, false);
      return;
    }

    if (message.type === "operation_result") {
      this.#settleOperation(message.payload);
      return;
    }
    if (message.type === "provide_file_bytes") {
      this.#settleFileRead(message.payload);
      return;
    }
    for (const listener of this.#listeners) listener(message);
  }

  #settleOperation(value: unknown): void {
    if (!isRecord(value) || typeof value.requestId !== "string" || typeof value.ok !== "boolean") {
      this.#reportError("invalid_operation_result", new Error("embedded whiteboard operation result is invalid"), false);
      return;
    }
    const pending = this.#pending.get(value.requestId);
    if (!pending) return;
    this.#pending.delete(value.requestId);
    clearTimeout(pending.timer);
    if (value.ok) {
      pending.resolve(value.result);
      return;
    }
    const message = isRecord(value.error) && typeof value.error.message === "string" ? value.error.message : "Whiteboard operation failed";
    pending.reject(new Error(message));
  }

  #settleFileRead(value: unknown): void {
    if (!isRecord(value) || typeof value.requestId !== "string" || typeof value.mimeType !== "string" || typeof value.dataURL !== "string") {
      this.#reportError("invalid_file_result", new Error("embedded whiteboard file result is invalid"), false);
      return;
    }
    const pending = this.#pending.get(value.requestId);
    if (!pending) return;
    this.#pending.delete(value.requestId);
    clearTimeout(pending.timer);
    pending.resolve({ mimeType: value.mimeType, dataURL: value.dataURL });
  }

  #reportError(code: string, cause: unknown, recoverable: boolean): void {
    const message = cause instanceof Error ? cause.message : "Embedded whiteboard bridge failed";
    try {
      this.post({ type: "error", payload: { code, message: message.slice(0, 256), recoverable } });
    } catch {
      // There is no safe secondary channel when the native bridge itself is unavailable.
    }
  }
}

function rendererContext() {
  const query = new URLSearchParams(window.location.search);
  const journeyId = query.get("journeyId");
  const rendererGeneration = query.get("rendererGeneration");
  if (!journeyId || !rendererGeneration) throw new Error("embedded whiteboard renderer context is missing");
  return {
    journeyId,
    rendererGeneration,
    nextMessageId: createMessageId,
  };
}

function createMessageId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `renderer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordMessageId(messageIds: Set<string>, messageId: string): boolean {
  if (messageIds.has(messageId)) return false;
  messageIds.add(messageId);
  if (messageIds.size > MAX_RECENT_MESSAGE_IDS) {
    const oldest = messageIds.values().next().value;
    if (oldest) messageIds.delete(oldest);
  }
  return true;
}
