import type React from "react";

import type { WhiteboardCollaborationEvent } from "@q9labsai/chalk-whiteboard";
import type { WhiteboardFileTransfer, WhiteboardWireElement } from "@q9labsai/chalk-whiteboard";
import { WhiteboardView, type WhiteboardViewProps } from "../../../../../sdks/typescript/react/src/components/whiteboard-view/WhiteboardView";
import type { SpaceViewWhiteboard } from "../../../../../sdks/typescript/react/src/components/space-view/SpaceView";

type WhiteboardCollab = NonNullable<WhiteboardViewProps["collab"]>;
type WhiteboardSubmitInput = Parameters<WhiteboardCollab["submitUpdate"]>[0];
type WhiteboardEventListener = Parameters<WhiteboardCollab["subscribe"]>[0];
type WhiteboardCommit = Awaited<ReturnType<WhiteboardCollab["clear"]>>;

const DEFAULT_SCENE_ID = "preview-scene";
const DEFAULT_SCENE_GENERATION = "preview-generation-0";
const DEFAULT_REVISION = "preview-revision-0";
const PREVIEW_TIMESTAMP = "2030-01-01T00:00:00.000Z";

export interface PreviewWhiteboardSnapshot {
  readonly sceneId: string;
  readonly sceneGeneration: string;
  readonly revision: string;
  readonly elements: readonly WhiteboardWireElement[];
  readonly appState?: { readonly viewBackgroundColor?: string };
}

export interface PreviewWhiteboardAdapterOptions {
  readonly sceneId?: string;
  readonly sceneGeneration?: string;
  readonly elements?: readonly WhiteboardWireElement[];
  readonly appState?: { readonly viewBackgroundColor?: string };
  readonly canDraw?: boolean;
}

export interface PreviewWhiteboardFile {
  readonly fileId: string;
  readonly mimeType: string;
  readonly dataURL: string;
}

export interface PreviewWhiteboardCursor {
  readonly x: number;
  readonly y: number;
}

export interface PreviewWhiteboardViewOptions extends Omit<WhiteboardViewProps, "collab"> {
  readonly adapter: PreviewWhiteboardAdapter;
}

export interface PreviewWhiteboardSpaceOptions extends PreviewWhiteboardViewOptions {
  readonly isOpen?: boolean;
}

/**
 * A local whiteboard transport with the same callbacks as the SDK transport.
 * It keeps scene, cursor, and file state in memory so copied preview URLs never
 * depend on RealtimeKit or a server-backed board.
 */
export class PreviewWhiteboardAdapter {
  readonly collaboration: WhiteboardCollab;
  private readonly listeners = new Set<WhiteboardEventListener>();
  private readonly files = new Map<string, PreviewWhiteboardFile>();
  private readonly baseSceneId: string;
  private readonly appState: { readonly viewBackgroundColor?: string } | undefined;
  private elements = new Map<string, WhiteboardWireElement>();
  private sceneId: string;
  private sceneGeneration: string;
  private revision = 0;
  private operation = 0;
  private lastCursor: PreviewWhiteboardCursor | null = null;

  constructor(options: PreviewWhiteboardAdapterOptions = {}) {
    this.baseSceneId = options.sceneId ?? DEFAULT_SCENE_ID;
    this.sceneId = this.baseSceneId;
    this.sceneGeneration = options.sceneGeneration ?? DEFAULT_SCENE_GENERATION;
    this.appState = options.appState;
    this.elements = toElementMap(options.elements ?? []);
    this.collaboration = {
      canDraw: options.canDraw ?? true,
      subscribe: (listener) => this.subscribe(listener),
      submitUpdate: (input) => this.submitUpdate(input),
      sendCursor: (input) => this.sendCursor(input),
      requestSnapshot: () => this.requestSnapshot(),
      clear: () => this.clear(),
      fileTransfer: this.createFileTransfer(),
    };
  }

  getSnapshot(): PreviewWhiteboardSnapshot {
    return {
      sceneId: this.sceneId,
      sceneGeneration: this.sceneGeneration,
      revision: revisionName(this.revision),
      elements: [...this.elements.values()],
      ...(this.appState ? { appState: this.appState } : {}),
    };
  }

  getLastCursor(): PreviewWhiteboardCursor | null {
    return this.lastCursor;
  }

  getFile(fileId: string): PreviewWhiteboardFile | null {
    return this.files.get(fileId) ?? null;
  }

  subscribe(listener: WhiteboardEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async requestSnapshot(): Promise<void> {
    const snapshot = this.getSnapshot();
    this.emit({
      type: "snapshot",
      sceneId: snapshot.sceneId,
      sceneGeneration: snapshot.sceneGeneration,
      revision: snapshot.revision,
      elements: snapshot.elements,
      ...(snapshot.appState ? { appState: snapshot.appState } : {}),
    });
  }

  async submitUpdate(input: WhiteboardSubmitInput): Promise<WhiteboardCommit> {
    const accepted = input.syncAll ? replaceElements(this.elements, input.elements) : mergeElements(this.elements, input.elements);
    this.elements = accepted;
    this.sceneId = input.sceneId;
    if (input.sceneGeneration) this.sceneGeneration = input.sceneGeneration;
    const commit = this.nextCommit();
    this.emit({
      type: "update",
      sceneId: commit.sceneId,
      sceneGeneration: commit.sceneGeneration,
      revision: commit.revision,
      elements: input.syncAll ? [...accepted.values()] : input.elements,
    });
    return commit;
  }

  sendCursor(input: PreviewWhiteboardCursor): void {
    this.lastCursor = { x: input.x, y: input.y };
  }

  async clear(): Promise<WhiteboardCommit> {
    this.elements = new Map();
    this.sceneGeneration = `${this.baseSceneId}-generation-${this.operation + 1}`;
    const commit = this.nextCommit();
    await this.requestSnapshot();
    return commit;
  }

  publishCursor(input: { readonly participantId: string; readonly displayName: string; readonly x: number; readonly y: number; readonly occurredAt?: string }): void {
    this.emit({
      type: "cursor",
      participantId: input.participantId,
      displayName: input.displayName,
      x: input.x,
      y: input.y,
      occurredAt: input.occurredAt ?? PREVIEW_TIMESTAMP,
    });
  }

  dispose(): void {
    this.listeners.clear();
    this.files.clear();
    this.lastCursor = null;
  }

  private nextCommit(): WhiteboardCommit {
    this.operation += 1;
    this.revision = this.operation;
    return {
      operationId: `preview-operation-${this.operation}`,
      sceneId: this.sceneId,
      revision: revisionName(this.revision),
      sceneGeneration: this.sceneGeneration,
    };
  }

  private emit(event: WhiteboardCollaborationEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private createFileTransfer(): WhiteboardFileTransfer {
    return {
      upload: async (input) => {
        this.files.set(input.fileId, { fileId: input.fileId, mimeType: input.mimeType, dataURL: input.dataURL });
      },
      download: async (fileId) => {
        const file = this.files.get(fileId);
        if (!file) throw new Error(`Preview whiteboard file ${fileId} is unavailable`);
        return { mimeType: file.mimeType, dataURL: file.dataURL };
      },
    };
  }
}

export function createPreviewWhiteboardAdapter(options: PreviewWhiteboardAdapterOptions = {}): PreviewWhiteboardAdapter {
  return new PreviewWhiteboardAdapter(options);
}

export function createPreviewWhiteboardProps({ adapter, ...viewProps }: PreviewWhiteboardViewOptions): WhiteboardViewProps {
  return { ...viewProps, collab: adapter.collaboration };
}

export function createPreviewWhiteboard({ adapter, isOpen = true, ...viewProps }: PreviewWhiteboardSpaceOptions): SpaceViewWhiteboard {
  return { isOpen, props: createPreviewWhiteboardProps({ adapter, ...viewProps }) };
}

export interface PreviewWhiteboardProps extends Omit<WhiteboardViewProps, "collab"> {
  readonly adapter: PreviewWhiteboardAdapter;
}

export function PreviewWhiteboard({ adapter, ...viewProps }: PreviewWhiteboardProps): React.JSX.Element {
  return <WhiteboardView {...viewProps} collab={adapter.collaboration} />;
}

function revisionName(value: number): string {
  return value === 0 ? DEFAULT_REVISION : `preview-revision-${value}`;
}

function toElementMap(elements: readonly WhiteboardWireElement[]): Map<string, WhiteboardWireElement> {
  return new Map(elements.map((element) => [element.id, element]));
}

function replaceElements(_current: Map<string, WhiteboardWireElement>, elements: readonly WhiteboardWireElement[]): Map<string, WhiteboardWireElement> {
  return toElementMap(elements);
}

function mergeElements(current: Map<string, WhiteboardWireElement>, incoming: readonly WhiteboardWireElement[]): Map<string, WhiteboardWireElement> {
  const next = new Map(current);
  for (const element of incoming) {
    const previous = next.get(element.id);
    if (!previous || isNewer(element, previous)) next.set(element.id, element);
  }
  return next;
}

function isNewer(next: WhiteboardWireElement, previous: WhiteboardWireElement): boolean {
  if (next.version !== previous.version) return next.version > previous.version;
  return next.version_nonce >= previous.version_nonce;
}
