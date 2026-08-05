import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import type { WhiteboardCommit, WhiteboardJsonValue, WhiteboardWireElement } from "../collab/wire";
import { chalkEmbeddedWhiteboardSupportedElementTypes } from "./manifest";
import {
  CHALK_EMBEDDED_WHITEBOARD_EXCALIDRAW_VERSION,
  CHALK_EMBEDDED_WHITEBOARD_MAX_MESSAGE_BYTES,
  CHALK_EMBEDDED_WHITEBOARD_RENDERER_BUILD_ID,
  decodeEmbeddedWhiteboardRendererMessage,
  encodeEmbeddedWhiteboardMessage,
  type ChalkEmbeddedWhiteboardHostMessage,
  type ChalkEmbeddedWhiteboardRendererEnvelope,
  type ChalkEmbeddedWhiteboardTheme,
  type ChalkEmbeddedWhiteboardViewport,
} from "./protocol";

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 16_384;
const MAX_DECODED_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_RECENT_MESSAGE_IDS = 2_048;
const permittedMimeTypes = new Set(["application/octet-stream", "image/gif", "image/jpeg", "image/png", "image/svg+xml", "image/webp"]);
const permittedRendererMetrics = new Set(["whiteboard.bridge.backlog", "whiteboard.file.failure", "whiteboard.frame.delay_ms", "whiteboard.input.delay_ms", "whiteboard.recovery.count", "whiteboard.renderer.memory_bytes", "whiteboard.renderer.termination"]);
const permittedRendererErrorCodes = new Set(["export_failed", "invalid_file_result", "invalid_host_message", "invalid_operation_result", "renderer_load_failed", "submission_failed"]);

export type ChalkEmbeddedWhiteboardTransportElement = {
  readonly id: string;
  readonly type: string;
  readonly version: number;
  readonly versionNonce: number;
  readonly index: string;
  readonly isDeleted: boolean;
  readonly payload: Readonly<Record<string, WhiteboardJsonValue>>;
};

export type ChalkEmbeddedWhiteboardTransportEvent =
  | {
      readonly type: "snapshot";
      readonly sceneId: string;
      readonly revision: string;
      readonly elements: readonly ChalkEmbeddedWhiteboardTransportElement[];
      readonly appState?: { readonly viewBackgroundColor?: string };
    }
  | {
      readonly type: "update";
      readonly sceneId: string;
      readonly revision: string;
      readonly elements: readonly ChalkEmbeddedWhiteboardTransportElement[];
    }
  | {
      readonly type: "cursor";
      readonly participantId: string;
      readonly displayName: string;
      readonly x: number;
      readonly y: number;
      readonly occurredAt: string;
    }
  | {
      readonly type: "reset_required";
      readonly sceneId: string;
      readonly reason: "scene_changed" | "cursor_expired" | "gap";
    };

export interface ChalkEmbeddedWhiteboardFileTransport {
  readonly initiateUpload: (input: { readonly fileId: string; readonly mimeType: string; readonly byteLength: number; readonly sha256: string }) => Promise<{
    readonly uploadId: string;
    readonly method: "PUT";
    readonly uploadUrl: string;
    readonly headers: Readonly<Record<string, string>>;
  }>;
  readonly finalizeUpload: (uploadId: string) => Promise<void>;
  readonly getDownloadUrl: (fileId: string) => Promise<{ readonly downloadUrl: string }>;
}

export interface ChalkEmbeddedWhiteboardTransport {
  readonly startSceneSubscription: () => Promise<void>;
  readonly stopSceneSubscription: () => void;
  readonly subscribe: (listener: (event: ChalkEmbeddedWhiteboardTransportEvent) => void) => () => void;
  readonly submitUpdate: (input: { readonly sceneId: string; readonly syncAll: boolean; readonly elements: readonly ChalkEmbeddedWhiteboardTransportElement[] }) => Promise<WhiteboardCommit>;
  readonly sendCursor: (input: { readonly x: number; readonly y: number }) => void;
  readonly requestSnapshot: () => Promise<void>;
  readonly clear: () => Promise<WhiteboardCommit>;
  readonly files: ChalkEmbeddedWhiteboardFileTransport;
}

export interface ChalkEmbeddedWhiteboardRendererPort {
  readonly postMessage: (message: string) => void;
  readonly subscribe: (listener: (message: string) => void) => () => void;
}

export interface ChalkEmbeddedWhiteboardControllerOptions {
  readonly renderer: ChalkEmbeddedWhiteboardRendererPort;
  readonly transport: ChalkEmbeddedWhiteboardTransport;
  readonly journeyId: string;
  readonly traceparent?: string;
  readonly tracestate?: string;
  readonly canDraw: boolean;
  readonly canClear: boolean;
  readonly theme?: ChalkEmbeddedWhiteboardTheme;
  readonly localParticipantColor?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly nextMessageId?: () => string;
  readonly onMetric?: (metric: { readonly name: string; readonly value: number; readonly attributes?: Readonly<Record<string, string | number | boolean>> }) => void;
  readonly onError?: (error: { readonly code: string; readonly message: string; readonly recoverable: boolean }) => void;
  readonly onCompatibilityChange?: (state: { readonly compatible: boolean; readonly message: string | null }) => void;
  readonly onUserExport?: (value: { readonly requestId: string; readonly format: "png" | "svg"; readonly mimeType: string; readonly dataURL: string }) => void;
  readonly onCloseReady?: (reason: string) => void;
}

export class ChalkWhiteboardController {
  readonly #fetch: typeof globalThis.fetch;
  readonly #nextMessageId: () => string;
  #canDraw: boolean;
  #canClear: boolean;
  #rendererGeneration: string | null = null;
  #sceneId: string | null = null;
  #sceneRevision: string | null = null;
  #sceneGeneration: string | null = null;
  #documentCompatible = true;
  #started = false;
  #transportStarted = false;
  readonly #rendererMessageIds = new Set<string>();
  readonly #fileTransfers = new Map<string, AbortController>();
  #unsubscribeRenderer: (() => void) | null = null;
  #unsubscribeTransport: (() => void) | null = null;

  constructor(readonly options: ChalkEmbeddedWhiteboardControllerOptions) {
    this.#canDraw = options.canDraw;
    this.#canClear = options.canClear;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#nextMessageId = options.nextMessageId ?? createMessageId;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#unsubscribeRenderer = this.options.renderer.subscribe((message) => {
      void this.#handleRendererMessage(message).catch((cause) => this.#reportHostError(cause));
    });
    this.#unsubscribeTransport = this.options.transport.subscribe((event) => this.#handleTransportEvent(event));
  }

  stop(): void {
    if (!this.#started) return;
    this.#started = false;
    this.#unsubscribeRenderer?.();
    this.#unsubscribeTransport?.();
    this.#unsubscribeRenderer = null;
    this.#unsubscribeTransport = null;
    this.#rendererGeneration = null;
    this.#sceneId = null;
    this.#sceneRevision = null;
    this.#sceneGeneration = null;
    this.#documentCompatible = true;
    this.#rendererMessageIds.clear();
    this.#abortFileTransfers();
    if (this.#transportStarted) this.options.transport.stopSceneSubscription();
    this.#transportStarted = false;
  }

  setCapabilities(value: { readonly canDraw: boolean; readonly canClear: boolean }): void {
    this.#canDraw = value.canDraw;
    this.#canClear = value.canClear;
    this.#sendEffectiveCapabilities();
  }

  setViewport(viewport: ChalkEmbeddedWhiteboardViewport): void {
    this.#send({ type: "set_viewport", payload: viewport });
  }

  requestUserExport(requestId: string, format: "png" | "svg"): void {
    this.#send({ type: "request_user_export", payload: { requestId, format } });
  }

  prepareClose(reason: string): void {
    this.#send({ type: "prepare_close", payload: { reason } });
  }

  rendererReloaded(): void {
    this.#rendererGeneration = null;
    this.#sceneGeneration = null;
    this.#rendererMessageIds.clear();
    this.#abortFileTransfers();
  }

  async #handleRendererMessage(raw: string): Promise<void> {
    const message = decodeEmbeddedWhiteboardRendererMessage(raw, this.#rendererGeneration ?? undefined);
    if (message.journeyId !== this.options.journeyId) throw new Error("embedded whiteboard journey does not match its host");
    if (message.type !== "ready" && this.#rendererGeneration === null) throw new Error("embedded whiteboard renderer is not ready");
    if (!recordMessageId(this.#rendererMessageIds, message.messageId)) return;

    switch (message.type) {
      case "ready":
        await this.#ready(message);
        return;
      case "local_update":
        await this.#localUpdate(message);
        return;
      case "cursor": {
        const payload = requireCursor(message.payload);
        this.options.transport.sendCursor(payload);
        return;
      }
      case "request_snapshot": {
        const { requestId } = requireRequest(message.payload);
        await this.#operation(requestId, () => this.options.transport.requestSnapshot());
        return;
      }
      case "clear": {
        const { requestId } = requireRequest(message.payload);
        await this.#operation(requestId, async () => {
          if (!this.#effectiveCanClear()) throw new Error("whiteboard clear is not permitted");
          const commit = await this.options.transport.clear();
          this.#sceneId = commit.sceneId;
          this.#sceneRevision = commit.revision;
          this.#sceneGeneration = createSceneGeneration();
          return { ...commit, sceneGeneration: this.#sceneGeneration };
        });
        return;
      }
      case "file_write":
        await this.#writeFile(message);
        return;
      case "file_read":
        await this.#readFile(message);
        return;
      case "camera":
        requireCamera(message.payload);
        return;
      case "metric":
        this.options.onMetric?.(requireMetric(message.payload));
        return;
      case "error":
        this.options.onError?.(requireRendererError(message.payload));
        return;
      case "user_export":
        this.options.onUserExport?.(requireUserExport(message.payload));
        return;
      case "close_ready":
        this.options.onCloseReady?.(requireCloseReady(message.payload).reason);
    }
  }

  async #ready(message: ChalkEmbeddedWhiteboardRendererEnvelope): Promise<void> {
    const payload = requireReady(message.payload);
    if (payload.excalidrawVersion !== CHALK_EMBEDDED_WHITEBOARD_EXCALIDRAW_VERSION || payload.supportedBridgeVersions[0] !== 1) {
      throw new Error("embedded whiteboard renderer compatibility check failed");
    }
    if (this.#rendererGeneration && this.#rendererGeneration !== message.rendererGeneration) {
      throw new Error("embedded whiteboard renderer generation changed without a reload");
    }

    this.#rendererGeneration = message.rendererGeneration;
    this.#send({
      type: "initialize",
      payload: {
        canDraw: this.#effectiveCanDraw(),
        canClear: this.#effectiveCanClear(),
        theme: this.options.theme ?? "light",
        ...(this.options.localParticipantColor ? { localParticipantColor: this.options.localParticipantColor } : {}),
      },
    });

    if (!this.#transportStarted) {
      await this.options.transport.startSceneSubscription();
      this.#transportStarted = true;
    } else {
      await this.options.transport.requestSnapshot();
    }
    this.options.onMetric?.({
      name: "whiteboard.renderer.ready",
      value: 1,
      attributes: { rendererBuildId: CHALK_EMBEDDED_WHITEBOARD_RENDERER_BUILD_ID },
    });
  }

  async #localUpdate(message: ChalkEmbeddedWhiteboardRendererEnvelope): Promise<void> {
    const payload = requireLocalUpdate(message.payload);
    await this.#operation(payload.requestId, async () => {
      if (!this.#effectiveCanDraw()) throw new Error("whiteboard drawing is not permitted");
      if (!this.#sceneId || !this.#sceneGeneration || payload.sceneId !== this.#sceneId || payload.sceneGeneration !== this.#sceneGeneration) {
        throw new Error("whiteboard update belongs to a stale scene generation");
      }
      const commit = await this.options.transport.submitUpdate({
        sceneId: payload.sceneId,
        syncAll: payload.syncAll,
        elements: payload.elements.map(fromWireTransportElement),
      });
      if (this.#sceneId !== payload.sceneId || this.#sceneGeneration !== payload.sceneGeneration || commit.sceneId !== payload.sceneId) {
        throw new Error("whiteboard update committed after its scene generation changed");
      }
      this.#sceneRevision = commit.revision;
      return commit;
    });
  }

  async #writeFile(message: ChalkEmbeddedWhiteboardRendererEnvelope): Promise<void> {
    const payload = requireFileWrite(message.payload);
    await this.#operation(payload.requestId, async () => {
      if (!this.#effectiveCanDraw()) throw new Error("whiteboard file upload is not permitted");
      const abortController = this.#beginFileTransfer(payload.requestId);
      try {
        const blob = await this.#dataURLBlob(payload.dataURL);
        if (blob.size !== payload.byteLength) throw new Error("whiteboard file byte length does not match");
        const validated = await validateFileBlob(blob, payload.mimeType);
        if (bytesToHex(sha256(validated.bytes)) !== payload.sha256.toLowerCase()) {
          throw new Error("whiteboard file digest does not match");
        }
        const upload = await this.options.transport.files.initiateUpload({
          fileId: payload.fileId,
          mimeType: validated.mimeType,
          byteLength: payload.byteLength,
          sha256: payload.sha256,
        });
        const response = await this.#fetch(upload.uploadUrl, {
          method: upload.method,
          headers: upload.headers,
          body: blob,
          signal: abortController.signal,
        });
        if (!response.ok) throw new Error(`whiteboard file upload failed with HTTP ${response.status}`);
        await this.options.transport.files.finalizeUpload(upload.uploadId);
      } finally {
        this.#finishFileTransfer(payload.requestId, abortController);
      }
    });
  }

  async #readFile(message: ChalkEmbeddedWhiteboardRendererEnvelope): Promise<void> {
    const payload = requireFileRead(message.payload);
    let abortController: AbortController | null = null;
    try {
      abortController = this.#beginFileTransfer(payload.requestId);
      const { downloadUrl } = await this.options.transport.files.getDownloadUrl(payload.fileId);
      const response = await this.#fetch(downloadUrl, { signal: abortController.signal });
      if (!response.ok) throw new Error(`whiteboard file download failed with HTTP ${response.status}`);
      const blob = await boundedResponseBlob(response);
      const { mimeType } = await validateFileBlob(blob, blob.type || "application/octet-stream");
      const normalizedBlob = blob.type === mimeType ? blob : new Blob([blob], { type: mimeType });
      const dataURL = await blobToDataURL(normalizedBlob);
      this.#send({
        type: "provide_file_bytes",
        payload: { requestId: payload.requestId, fileId: payload.fileId, mimeType, dataURL },
      });
    } catch (cause) {
      this.#sendOperationFailure(payload.requestId, cause);
    } finally {
      if (abortController) this.#finishFileTransfer(payload.requestId, abortController);
    }
  }

  async #operation(requestId: string, operation: () => unknown | Promise<unknown>): Promise<void> {
    try {
      const result = await operation();
      this.#send({ type: "operation_result", payload: { requestId, ok: true, ...(result === undefined ? {} : { result }) } });
    } catch (cause) {
      this.#sendOperationFailure(requestId, cause);
    }
  }

  #handleTransportEvent(event: ChalkEmbeddedWhiteboardTransportEvent): void {
    switch (event.type) {
      case "snapshot": {
        if (!isRevision(event.revision)) {
          this.#reportHostError(new Error("whiteboard snapshot revision is invalid"));
          return;
        }
        this.#updateDocumentCompatibility(event.elements);
        this.#sceneId = event.sceneId;
        this.#sceneRevision = event.revision;
        this.#sceneGeneration = createSceneGeneration();
        this.#send({
          type: "apply_snapshot",
          payload: {
            sceneId: event.sceneId,
            revision: event.revision,
            sceneGeneration: this.#sceneGeneration,
            elements: event.elements.map(toWireTransportElement),
            ...(event.appState ? { appState: event.appState } : {}),
          },
        });
        return;
      }
      case "update": {
        if (!this.#sceneId || !this.#sceneGeneration || event.sceneId !== this.#sceneId) {
          this.#invalidateSceneAndRecover(event.sceneId, "scene_changed");
          return;
        }
        if (!isRevision(event.revision)) {
          this.#invalidateSceneAndRecover(event.sceneId, "gap");
          return;
        }
        if (this.#sceneRevision && compareRevision(event.revision, this.#sceneRevision) <= 0) return;
        this.#updateDocumentCompatibility(event.elements);
        this.#sceneRevision = event.revision;
        this.#send({
          type: "apply_update",
          payload: {
            sceneId: event.sceneId,
            revision: event.revision,
            sceneGeneration: this.#sceneGeneration,
            elements: event.elements.map(toWireTransportElement),
          },
        });
        return;
      }
      case "cursor":
        this.#send({ type: "apply_cursor", payload: event });
        return;
      case "reset_required":
        this.#sceneGeneration = null;
        this.#send({ type: "reset_required", payload: event });
    }
  }

  #invalidateSceneAndRecover(sceneId: string, reason: "scene_changed" | "gap"): void {
    this.#sceneId = null;
    this.#sceneRevision = null;
    this.#sceneGeneration = null;
    this.#send({ type: "reset_required", payload: { sceneId, reason } });
    void this.options.transport.requestSnapshot().catch((cause) => this.#reportHostError(cause));
  }

  #effectiveCanDraw(): boolean {
    return this.#canDraw && this.#documentCompatible;
  }

  #effectiveCanClear(): boolean {
    return this.#canClear && this.#documentCompatible;
  }

  #sendEffectiveCapabilities(): void {
    this.#send({
      type: "set_capabilities",
      payload: {
        canDraw: this.#effectiveCanDraw(),
        canClear: this.#effectiveCanClear(),
      },
    });
  }

  #updateDocumentCompatibility(elements: readonly ChalkEmbeddedWhiteboardTransportElement[]): void {
    const compatible = elements.every((element) => chalkEmbeddedWhiteboardSupportedElementTypes.has(element.type));
    if (compatible === this.#documentCompatible) return;
    this.#documentCompatible = compatible;
    this.#sendEffectiveCapabilities();
    this.options.onCompatibilityChange?.({
      compatible,
      message: compatible ? null : "This whiteboard uses a feature this app cannot edit. Update required.",
    });
    if (!compatible) {
      this.options.onError?.({
        code: "update_required",
        message: "This whiteboard uses a feature this app cannot edit. Update required.",
        recoverable: false,
      });
    }
  }

  #send(message: ChalkEmbeddedWhiteboardHostMessage): void {
    if (!this.#started || !this.#rendererGeneration) return;
    this.options.renderer.postMessage(
      encodeEmbeddedWhiteboardMessage(message, {
        rendererGeneration: this.#rendererGeneration,
        journeyId: this.options.journeyId,
        ...(this.options.traceparent ? { traceparent: this.options.traceparent } : {}),
        ...(this.options.tracestate ? { tracestate: this.options.tracestate } : {}),
        nextMessageId: this.#nextMessageId,
      }),
    );
  }

  #sendOperationFailure(requestId: string, cause: unknown): void {
    const message = safeErrorMessage(cause);
    this.#send({
      type: "operation_result",
      payload: {
        requestId,
        ok: false,
        error: { code: "operation_failed", message, recoverable: true },
      },
    });
    this.options.onError?.({ code: "operation_failed", message, recoverable: true });
  }

  #reportHostError(cause: unknown): void {
    const message = safeErrorMessage(cause);
    this.options.onError?.({ code: "invalid_renderer_message", message, recoverable: false });
  }

  async #dataURLBlob(dataURL: string): Promise<Blob> {
    if (!dataURL.startsWith("data:") || dataURL.length > Math.ceil((MAX_FILE_BYTES * 4) / 3) + 1024) {
      throw new Error("whiteboard file data is invalid");
    }
    const separator = dataURL.indexOf(",");
    if (separator < 0) throw new Error("whiteboard file data is invalid");
    const metadata = dataURL.slice(5, separator).split(";");
    const mimeType = normalizeMimeType(metadata[0] ?? "");
    if (metadata.length !== 2 || metadata[1]?.toLowerCase() !== "base64") {
      throw new Error("whiteboard file data must use base64 encoding");
    }
    let decoded: string;
    try {
      decoded = atob(dataURL.slice(separator + 1));
    } catch {
      throw new Error("whiteboard file data is not valid base64");
    }
    const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    const blob = new Blob([bytes], { type: mimeType });
    if (blob.size > MAX_FILE_BYTES) throw new Error("whiteboard file exceeds the renderer transfer limit");
    return blob;
  }

  #beginFileTransfer(requestId: string): AbortController {
    if (this.#fileTransfers.has(requestId)) throw new Error("whiteboard file request is already active");
    const abortController = new AbortController();
    this.#fileTransfers.set(requestId, abortController);
    return abortController;
  }

  #finishFileTransfer(requestId: string, abortController: AbortController): void {
    if (this.#fileTransfers.get(requestId) === abortController) this.#fileTransfers.delete(requestId);
  }

  #abortFileTransfers(): void {
    for (const abortController of this.#fileTransfers.values()) abortController.abort();
    this.#fileTransfers.clear();
  }
}

function toWireTransportElement(element: ChalkEmbeddedWhiteboardTransportElement): WhiteboardWireElement {
  return {
    id: element.id,
    type: element.type,
    version: element.version,
    version_nonce: element.versionNonce,
    index: element.index,
    is_deleted: element.isDeleted,
    payload: element.payload,
  };
}

function fromWireTransportElement(element: WhiteboardWireElement): ChalkEmbeddedWhiteboardTransportElement {
  return {
    id: element.id,
    type: element.type,
    version: element.version,
    versionNonce: element.version_nonce,
    index: element.index,
    isDeleted: element.is_deleted,
    payload: element.payload,
  };
}

function requireReady(value: unknown) {
  const record = requireRecord(value, ["excalidrawVersion", "supportedBridgeVersions"]);
  if (record.excalidrawVersion !== CHALK_EMBEDDED_WHITEBOARD_EXCALIDRAW_VERSION || !Array.isArray(record.supportedBridgeVersions) || record.supportedBridgeVersions.length !== 1 || record.supportedBridgeVersions[0] !== 1) {
    throw new Error("embedded whiteboard ready payload is invalid");
  }
  return {
    excalidrawVersion: CHALK_EMBEDDED_WHITEBOARD_EXCALIDRAW_VERSION,
    supportedBridgeVersions: [1] as const,
  };
}

function requireLocalUpdate(value: unknown) {
  const record = requireRecord(value, ["requestId", "sceneId", "sceneGeneration", "syncAll", "elements"]);
  if (typeof record.syncAll !== "boolean" || !Array.isArray(record.elements)) throw new Error("embedded whiteboard local update is invalid");
  return {
    requestId: requireString(record.requestId, "request ID"),
    sceneId: requireString(record.sceneId, "scene ID"),
    sceneGeneration: requireString(record.sceneGeneration, "scene generation"),
    syncAll: record.syncAll,
    elements: record.elements.map(requireWireElement),
  };
}

function requireCursor(value: unknown) {
  const record = requireRecord(value, ["x", "y"]);
  if (!isFiniteNumber(record.x) || !isFiniteNumber(record.y)) throw new Error("embedded whiteboard cursor is invalid");
  return { x: record.x, y: record.y };
}

function requireCamera(value: unknown) {
  const record = requireRecord(value, ["scrollX", "scrollY", "zoom"]);
  if (!isFiniteNumber(record.scrollX) || !isFiniteNumber(record.scrollY) || !isFiniteNumber(record.zoom) || record.zoom <= 0) {
    throw new Error("embedded whiteboard camera is invalid");
  }
  return { scrollX: record.scrollX, scrollY: record.scrollY, zoom: record.zoom };
}

function requireRequest(value: unknown) {
  const record = requireRecord(value, ["requestId"]);
  return { requestId: requireString(record.requestId, "request ID") };
}

function requireFileWrite(value: unknown) {
  const record = requireRecord(value, ["requestId", "fileId", "mimeType", "byteLength", "sha256", "dataURL"]);
  const byteLength = record.byteLength;
  const sha256 = requireString(record.sha256, "file digest");
  if (!Number.isSafeInteger(byteLength) || Number(byteLength) <= 0 || Number(byteLength) > MAX_FILE_BYTES || !/^[\da-f]{64}$/iu.test(sha256)) {
    throw new Error("embedded whiteboard file metadata is invalid");
  }
  return {
    requestId: requireString(record.requestId, "request ID"),
    fileId: requireString(record.fileId, "file ID"),
    mimeType: normalizeMimeType(requireString(record.mimeType, "MIME type")),
    byteLength: Number(byteLength),
    sha256: sha256.toLowerCase(),
    dataURL: requireString(record.dataURL, "file data", Math.ceil((MAX_FILE_BYTES * 4) / 3) + 1_024),
  };
}

function requireFileRead(value: unknown) {
  const record = requireRecord(value, ["requestId", "fileId"]);
  return { requestId: requireString(record.requestId, "request ID"), fileId: requireString(record.fileId, "file ID") };
}

function requireMetric(value: unknown) {
  const record = requireRecord(value, ["name", "value"], ["attributes"]);
  if (!isFiniteNumber(record.value)) throw new Error("embedded whiteboard metric is invalid");
  const name = requireString(record.name, "metric name");
  if (!permittedRendererMetrics.has(name)) throw new Error("embedded whiteboard metric is unsupported");
  return {
    name,
    value: record.value,
  };
}

function requireRendererError(value: unknown) {
  const record = requireRecord(value, ["code", "message", "recoverable"]);
  if (typeof record.recoverable !== "boolean") throw new Error("embedded whiteboard error is invalid");
  const code = requireString(record.code, "error code");
  if (!permittedRendererErrorCodes.has(code)) throw new Error("embedded whiteboard error code is unsupported");
  return {
    code,
    message: `The embedded whiteboard reported ${code.replaceAll("_", " ")}.`,
    recoverable: record.recoverable,
  };
}

function requireUserExport(value: unknown): { readonly requestId: string; readonly format: "png" | "svg"; readonly mimeType: string; readonly dataURL: string } {
  const record = requireRecord(value, ["requestId", "format", "mimeType", "dataURL"]);
  if (record.format !== "png" && record.format !== "svg") throw new Error("embedded whiteboard export is invalid");
  return {
    requestId: requireString(record.requestId, "request ID"),
    format: record.format,
    mimeType: normalizeMimeType(requireString(record.mimeType, "MIME type")),
    dataURL: requireString(record.dataURL, "export data", CHALK_EMBEDDED_WHITEBOARD_MAX_MESSAGE_BYTES - 1_024),
  };
}

function requireCloseReady(value: unknown) {
  const record = requireRecord(value, ["reason"]);
  return { reason: requireString(record.reason, "close reason") };
}

function requireWireElement(value: unknown): WhiteboardWireElement {
  const record = requireRecord(value, ["id", "type", "version", "version_nonce", "index", "is_deleted", "payload"]);
  if (!Number.isSafeInteger(record.version) || Number(record.version) < 0 || !Number.isSafeInteger(record.version_nonce) || Number(record.version_nonce) < 0 || typeof record.is_deleted !== "boolean" || !isRecord(record.payload)) {
    throw new Error("embedded whiteboard element is invalid");
  }
  return {
    id: requireString(record.id, "element ID"),
    type: requireString(record.type, "element type"),
    version: Number(record.version),
    version_nonce: Number(record.version_nonce),
    index: requireString(record.index, "element index"),
    is_deleted: record.is_deleted,
    payload: record.payload as Readonly<Record<string, WhiteboardJsonValue>>,
  };
}

function requireRecord(value: unknown, requiredKeys: readonly string[], optionalKeys: readonly string[] = []): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("embedded whiteboard message payload is invalid");
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (!requiredKeys.every((key) => Object.hasOwn(value, key)) || !Object.keys(value).every((key) => allowed.has(key))) {
    throw new Error("embedded whiteboard message payload fields are invalid");
  }
  return value;
}

function requireString(value: unknown, label: string, maxBytes = 32 * 1024): string {
  if (typeof value !== "string" || value.length === 0 || new TextEncoder().encode(value).byteLength > maxBytes) throw new Error(`embedded whiteboard ${label} is invalid`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeMimeType(value: string): string {
  const mimeType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!permittedMimeTypes.has(mimeType)) throw new Error("whiteboard file MIME type is not permitted");
  return mimeType;
}

async function validateFileBlob(blob: Blob, claimedMimeType: string): Promise<{ readonly bytes: Uint8Array; readonly mimeType: string }> {
  if (blob.size <= 0 || blob.size > MAX_FILE_BYTES) throw new Error("whiteboard file exceeds the renderer transfer limit");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const claimed = normalizeMimeType(claimedMimeType);
  const declared = blob.type ? normalizeMimeType(blob.type) : "application/octet-stream";
  if (claimed !== "application/octet-stream" && declared !== claimed) {
    throw new Error("whiteboard file declared MIME type does not match");
  }
  const detected = detectFileMimeType(bytes);
  const mimeType = claimed === "application/octet-stream" && detected ? detected : claimed;
  if (detected && mimeType !== detected) throw new Error("whiteboard file MIME signature does not match");
  if (mimeType.startsWith("image/") && !detected) throw new Error("whiteboard image signature is invalid");

  const dimensions = imageDimensions(bytes, mimeType);
  if (mimeType.startsWith("image/") && !dimensions) throw new Error("whiteboard image dimensions are invalid");
  if (dimensions) validateImageDimensions(dimensions);
  if (mimeType === "image/svg+xml") validateSvg(new TextDecoder().decode(bytes));
  return { bytes, mimeType };
}

async function boundedResponseBlob(response: Response): Promise<Blob> {
  const contentEncoding = response.headers.get("content-encoding");
  if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
    throw new Error("whiteboard file download uses an unsupported content encoding");
  }
  const contentLength = response.headers.get("content-length");
  if (!contentLength || !/^[1-9]\d*$/u.test(contentLength)) {
    throw new Error("whiteboard file download is missing a valid content length");
  }
  const expectedBytes = Number(contentLength);
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes > MAX_FILE_BYTES) {
    throw new Error("whiteboard file download exceeds the renderer transfer limit");
  }
  const blob = await response.blob();
  if (blob.size !== expectedBytes || blob.size > MAX_FILE_BYTES) {
    throw new Error("whiteboard file download byte length does not match");
  }
  return blob;
}

function detectFileMimeType(bytes: Uint8Array): string | null {
  if (hasBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (hasBytes(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  const prefix = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 1_024))).replace(/^\uFEFF/u, "");
  if (/^\s*(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/iu.test(prefix)) return "image/svg+xml";
  return null;
}

function imageDimensions(bytes: Uint8Array, mimeType: string): { readonly width: number; readonly height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (mimeType) {
    case "image/png":
      return bytes.length >= 24 ? { width: view.getUint32(16), height: view.getUint32(20) } : null;
    case "image/gif":
      return bytes.length >= 10 ? { width: view.getUint16(6, true), height: view.getUint16(8, true) } : null;
    case "image/jpeg":
      return jpegDimensions(bytes);
    case "image/webp":
      return webpDimensions(bytes);
    case "image/svg+xml":
      return svgDimensions(new TextDecoder().decode(bytes));
    default:
      return null;
  }
}

function jpegDimensions(bytes: Uint8Array): { readonly width: number; readonly height: number } | null {
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1] ?? 0;
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > bytes.length) return null;
    const segmentLength = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return {
        height: (bytes[offset + 3]! << 8) | bytes[offset + 4]!,
        width: (bytes[offset + 5]! << 8) | bytes[offset + 6]!,
      };
    }
    offset += segmentLength;
  }
  return null;
}

function webpDimensions(bytes: Uint8Array): { readonly width: number; readonly height: number } | null {
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8X" && bytes.length >= 30) {
    return {
      width: 1 + uint24(bytes, 24),
      height: 1 + uint24(bytes, 27),
    };
  }
  if (chunk === "VP8 " && bytes.length >= 30 && hasBytes(bytes, [0x9d, 0x01, 0x2a], 23)) {
    return {
      width: (bytes[26]! | (bytes[27]! << 8)) & 0x3fff,
      height: (bytes[28]! | (bytes[29]! << 8)) & 0x3fff,
    };
  }
  if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    return {
      width: 1 + (bytes[21]! | ((bytes[22]! & 0x3f) << 8)),
      height: 1 + ((bytes[22]! >> 6) | (bytes[23]! << 2) | ((bytes[24]! & 0x0f) << 10)),
    };
  }
  return null;
}

function svgDimensions(svg: string): { readonly width: number; readonly height: number } | null {
  const root = /^\s*(?:<\?xml[^>]*>\s*)?<svg\b([^>]*)>/iu.exec(svg)?.[1];
  if (!root) return null;
  const width = numericSvgAttribute(root, "width");
  const height = numericSvgAttribute(root, "height");
  if (width && height) return { width, height };
  const viewBox = /\bviewBox\s*=\s*["']\s*[-+\d.eE]+\s+[-+\d.eE]+\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s*["']/u.exec(root);
  if (!viewBox) return null;
  return { width: Number(viewBox[1]), height: Number(viewBox[2]) };
}

function numericSvgAttribute(attributes: string, name: string): number | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*["']\\s*([-+\\d.eE]+)`, "u").exec(attributes);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function validateImageDimensions(dimensions: { readonly width: number; readonly height: number }): void {
  if (!Number.isFinite(dimensions.width) || !Number.isFinite(dimensions.height) || dimensions.width <= 0 || dimensions.height <= 0 || dimensions.width > MAX_IMAGE_DIMENSION || dimensions.height > MAX_IMAGE_DIMENSION || dimensions.width * dimensions.height * 4 > MAX_DECODED_IMAGE_BYTES) {
    throw new Error("whiteboard image dimensions exceed the decoded-memory limit");
  }
}

function validateSvg(svg: string): void {
  if (
    !/^\s*(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/iu.test(svg) ||
    /<!DOCTYPE|<!ENTITY/iu.test(svg) ||
    /<(?:script|foreignObject|iframe|object|embed|audio|video|use|image)\b/iu.test(svg) ||
    /\bon[a-z]+\s*=/iu.test(svg) ||
    /\b(?:href|src)\s*=\s*["']?\s*(?:https?:|\/\/|javascript:)/iu.test(svg) ||
    /\burl\(\s*["']?\s*(?:https?:|\/\/|javascript:)/iu.test(svg)
  ) {
    throw new Error("whiteboard SVG contains unsafe external or executable content");
  }
}

function hasBytes(bytes: Uint8Array, expected: readonly number[], offset = 0): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function uint24(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("whiteboard file could not be encoded"));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

function safeErrorMessage(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : "Whiteboard operation failed";
  const redacted = raw
    .replace(/\b(?:https?|wss?):\/\/\S+/giu, "[redacted-url]")
    .replace(/\b(?:bearer|token|authorization|credential|secret)\b\s*[:=]?\s*\S*/giu, "[redacted-credential]")
    .replace(/\bdata:[^,\s]+,[^\s]+/giu, "[redacted-data]");
  return redacted.length > 256 ? `${redacted.slice(0, 253)}...` : redacted;
}

function compareRevision(left: string, right: string): number {
  const leftRevision = BigInt(left);
  const rightRevision = BigInt(right);
  return leftRevision === rightRevision ? 0 : leftRevision > rightRevision ? 1 : -1;
}

function isRevision(value: string): boolean {
  return /^(?:0|[1-9]\d*)$/u.test(value);
}

function createSceneGeneration(): string {
  const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  if (randomUUID) return randomUUID();
  return `scene-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createMessageId(): string {
  const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  if (randomUUID) return randomUUID();
  return `chalk-whiteboard-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
