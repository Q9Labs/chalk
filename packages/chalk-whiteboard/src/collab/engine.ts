import {
	CaptureUpdateAction,
	getSceneVersion,
	reconcileElements,
	restoreElements,
} from "@excalidraw/excalidraw";

import { WhiteboardFilesSync } from "./files";
import { WhiteboardPresence } from "./presence";
import { filterSyncableElements } from "./syncable";
import type { AppState, ExcalidrawImperativeAPI, OrderedExcalidrawElement } from "./types";

const FULL_SYNC_INTERVAL_MS = 20_000;
const CHANGE_DEBOUNCE_MS = 150;
const CURSOR_THROTTLE_MS = 16;
const CURSOR_STALE_MS = 10_000;

const asArray = (value: unknown) => (Array.isArray(value) ? value : []);

export class ExcalidrawCollabEngine {
	private sceneId: string | null = null;
	private canDraw = true;

	private localSeq = 0;
	private lastBroadcastedOrReceivedSceneVersion = 0;
	private broadcastedElementVersions = new Map<string, number>();

	private changeDebounce: ReturnType<typeof setTimeout> | null = null;
	private fullSyncTimer: ReturnType<typeof setTimeout> | null = null;

	private hadAnyElements = false;

	private readonly filesSync: WhiteboardFilesSync;
	private readonly presence: WhiteboardPresence;
	private readonly unsubPointerUp: (() => void) | null;

	constructor(
		private readonly opts: {
			excalidrawAPI: ExcalidrawImperativeAPI;
			canDraw: boolean;
			sendUpdateV2: (payload: {
				schemaVersion: 2;
				sceneId: string;
				syncAll: boolean;
				elements: readonly OrderedExcalidrawElement[];
				seq: number;
			}) => void;
			sendCursor: (payload: { x: number; y: number }) => void;
			requestSync: () => void;
			sendClear?: () => void;
			presignUpload: (
				fileId: string,
				mimeType: string,
			) => Promise<{ uploadUrl: string }>;
			presignDownload: (fileId: string) => Promise<{ downloadUrl: string }>;
		},
	) {
		this.canDraw = opts.canDraw;

		this.filesSync = new WhiteboardFilesSync({
			excalidrawAPI: opts.excalidrawAPI,
			presignUpload: opts.presignUpload,
			presignDownload: opts.presignDownload,
			uploadThrottleMs: 300,
			downloadThrottleMs: 500,
		});

		this.presence = new WhiteboardPresence({
			excalidrawAPI: opts.excalidrawAPI,
			sendCursor: opts.sendCursor,
			throttleMs: CURSOR_THROTTLE_MS,
			staleMs: CURSOR_STALE_MS,
		});

		this.unsubPointerUp = opts.excalidrawAPI.onPointerUp?.(() => this.flushNow());
	}

	setCanDraw(next: boolean): void {
		this.canDraw = next;
	}

	dispose(): void {
		if (this.changeDebounce) clearTimeout(this.changeDebounce);
		if (this.fullSyncTimer) clearTimeout(this.fullSyncTimer);
		this.changeDebounce = null;
		this.fullSyncTimer = null;
		this.filesSync.dispose();
		this.presence.dispose();
		this.unsubPointerUp?.();
	}

	handleChange(
		_elements: readonly OrderedExcalidrawElement[],
		_appState: AppState,
		files: any,
	): void {
		const elementsAll = this.opts.excalidrawAPI.getSceneElementsIncludingDeleted() as any;
		this.filesSync.handleLocalScene(elementsAll, files ?? {});

		if (!this.canDraw) return;

		if (this.changeDebounce) clearTimeout(this.changeDebounce);
		this.changeDebounce = setTimeout(() => {
			this.changeDebounce = null;
			this.flushNow();
		}, CHANGE_DEBOUNCE_MS);
	}

	handlePointerUpdate(payload: { pointer: { x: number; y: number } }): void {
		this.presence.handlePointerUpdate(payload);
	}

	handleRemoteCursor(payload: {
		participantId: string;
		displayName: string;
		x: number;
		y: number;
		timestamp: Date;
	}): void {
		this.presence.handleRemoteCursor(payload);
	}

	handleRemoteData(payload: {
		sceneId?: string;
		syncAll?: boolean;
		elements: unknown[];
	}): void {
		this.applyRemoteElements({
			sceneId: payload.sceneId ?? null,
			syncAll: !!payload.syncAll,
			remoteElements: payload.elements,
			isSnapshot: false,
		});
	}

	handleRemoteSnapshot(payload: { sceneId?: string; elements: unknown[] }): void {
		this.applyRemoteElements({
			sceneId: payload.sceneId ?? null,
			syncAll: true,
			remoteElements: payload.elements,
			isSnapshot: true,
		});
	}

	private flushNow(): void {
		if (!this.canDraw) return;
		if (!this.sceneId) {
			this.opts.requestSync();
			return;
		}

		const excalidrawAPI = this.opts.excalidrawAPI;
		const elementsAll = excalidrawAPI.getSceneElementsIncludingDeleted() as any[];

		const nonDeletedCount = elementsAll.filter((el) => !el.isDeleted).length;
		const hasAny = nonDeletedCount > 0;
		const becameEmpty = this.hadAnyElements && !hasAny;
		this.hadAnyElements = this.hadAnyElements || hasAny;

		if (becameEmpty && this.opts.sendClear) {
			// Canvas cleared locally. Advance epoch to prevent resurrection from in-flight updates.
			this.opts.sendClear();
			this.sceneId = null;
			this.broadcastedElementVersions.clear();
			this.lastBroadcastedOrReceivedSceneVersion = 0;
			this.hadAnyElements = false;
			this.opts.requestSync();
			return;
		}

		const sceneVersion = getSceneVersion(elementsAll as any);
		if (sceneVersion <= this.lastBroadcastedOrReceivedSceneVersion) return;

		const nowMs = Date.now();
		const syncableAll = filterSyncableElements(elementsAll as any, nowMs);

		const delta: OrderedExcalidrawElement[] = [];
		for (const el of syncableAll as any[]) {
			const prev = this.broadcastedElementVersions.get(el.id) ?? 0;
			if (!prev || el.version > prev) delta.push(el);
		}
		if (delta.length === 0) return;

		this.localSeq += 1;
		this.opts.sendUpdateV2({
			schemaVersion: 2,
			sceneId: this.sceneId,
			syncAll: false,
			elements: delta,
			seq: this.localSeq,
		});

		for (const el of delta as any[]) {
			this.broadcastedElementVersions.set(el.id, el.version);
		}

		this.lastBroadcastedOrReceivedSceneVersion = sceneVersion;
		this.scheduleFullSync();
	}

	private scheduleFullSync() {
		if (this.fullSyncTimer) return;
		this.fullSyncTimer = setTimeout(() => {
			this.fullSyncTimer = null;
			this.sendFullSync();
		}, FULL_SYNC_INTERVAL_MS);
	}

	private sendFullSync() {
		if (!this.canDraw) return;
		if (!this.sceneId) {
			this.opts.requestSync();
			return;
		}

		const excalidrawAPI = this.opts.excalidrawAPI;
		const elementsAll = excalidrawAPI.getSceneElementsIncludingDeleted() as any[];
		const syncableAll = filterSyncableElements(elementsAll as any, Date.now());

		this.localSeq += 1;
		this.opts.sendUpdateV2({
			schemaVersion: 2,
			sceneId: this.sceneId,
			syncAll: true,
			elements: syncableAll as any,
			seq: this.localSeq,
		});

		for (const el of syncableAll as any[]) {
			this.broadcastedElementVersions.set(el.id, el.version);
		}

		this.lastBroadcastedOrReceivedSceneVersion = getSceneVersion(elementsAll as any);
	}

	private applyRemoteElements(args: {
		sceneId: string | null;
		syncAll: boolean;
		remoteElements: unknown[];
		isSnapshot: boolean;
	}) {
		const remoteSceneId = args.sceneId;
		if (!remoteSceneId) {
			this.opts.requestSync();
			return;
		}

		if (!this.sceneId) {
			this.sceneId = remoteSceneId;
		} else if (args.isSnapshot) {
			if (remoteSceneId !== this.sceneId) {
				this.sceneId = remoteSceneId;
				this.broadcastedElementVersions.clear();
				this.lastBroadcastedOrReceivedSceneVersion = 0;
				this.hadAnyElements = false;
			}
		} else if (remoteSceneId !== this.sceneId) {
			// Clear update (epoch advance): accept immediately.
			if (args.syncAll && asArray(args.remoteElements).length === 0) {
				this.sceneId = remoteSceneId;
				this.broadcastedElementVersions.clear();
				this.lastBroadcastedOrReceivedSceneVersion = 0;
				this.hadAnyElements = false;
			} else {
				this.opts.requestSync();
				return;
			}
		}

		const excalidrawAPI = this.opts.excalidrawAPI;
		const local = excalidrawAPI.getSceneElementsIncludingDeleted() as any[];
		const remote = args.remoteElements as any[];

		const restoredRemote = restoreElements(remote as any, local as any);
		const reconciled = reconcileElements(
			local as any,
			restoredRemote as any,
			excalidrawAPI.getAppState(),
		);

		// Echo prevention: update before applying so onChange sees it and bails.
		this.lastBroadcastedOrReceivedSceneVersion = getSceneVersion(reconciled as any);
		this.broadcastedElementVersions.clear();
		for (const el of reconciled as any[]) {
			this.broadcastedElementVersions.set(el.id, el.version);
			if (!el.isDeleted) this.hadAnyElements = true;
		}

		excalidrawAPI.updateScene({
			elements: reconciled as any,
			captureUpdate: CaptureUpdateAction.NEVER,
		});

		this.filesSync.handleRemoteScene(reconciled as any);
	}
}

