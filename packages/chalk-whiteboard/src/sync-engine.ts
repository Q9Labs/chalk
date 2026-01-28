import type { BinaryFiles, ExcalidrawElement, WhiteboardConfig } from "./types";
import { DEFAULT_CONFIG } from "./types";

export type SendMessage = (type: string, payload: unknown) => void;

/**
 * SyncEngine handles delta updates and debouncing for whiteboard sync
 */
export class SyncEngine {
	private lastElements: Map<string, ExcalidrawElement> = new Map();
	private lastFiles: Set<string> = new Set();
	private localSeq = 0;
	private pendingElements: Map<string, ExcalidrawElement> = new Map();
	private pendingFiles: BinaryFiles = {};
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private lastCursorSend = 0;
	private readonly config: Required<WhiteboardConfig>;
	private remoteSeqBySource: Map<string, number> = new Map();

	private splitFilesIntoBatches(
		files: BinaryFiles,
		basePayloadSize: number,
	): BinaryFiles[] {
		const batches: BinaryFiles[] = [];
		let current: BinaryFiles = {};
		let currentSize = basePayloadSize;

		for (const [id, file] of Object.entries(files)) {
			const fileSize = JSON.stringify({ [id]: file }).length;
			if (fileSize > this.config.maxFileBytes) {
				continue;
			}

			if (
				currentSize + fileSize > this.config.maxPayloadBytes &&
				Object.keys(current).length > 0
			) {
				batches.push(current);
				current = {};
				currentSize = basePayloadSize;
			}

			current[id] = file;
			currentSize += fileSize;
		}

		if (Object.keys(current).length > 0) {
			batches.push(current);
		}

		return batches;
	}

	constructor(
		private readonly sendMessage: SendMessage,
		config?: WhiteboardConfig,
	) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	/**
	 * Called on every Excalidraw onChange
	 * Debounces and sends only changed elements
	 */
	handleChange(
		elements: readonly ExcalidrawElement[],
		files: BinaryFiles,
	): void {
		// Find changed elements
		const changedElements: ExcalidrawElement[] = [];

		for (const element of elements) {
			const existing = this.lastElements.get(element.id);
			if (!existing || existing.version !== element.version) {
				changedElements.push(element);
				this.lastElements.set(element.id, element);
			}
		}

		// Find deleted elements (marked as isDeleted: true)
		for (const element of elements) {
			if (element.isDeleted && this.lastElements.has(element.id)) {
				changedElements.push(element);
			}
		}

		// Find new files
		const newFiles: BinaryFiles = {};
		for (const [id, file] of Object.entries(files)) {
			if (!this.lastFiles.has(id)) {
				newFiles[id] = file;
				this.lastFiles.add(id);
			}
		}

		// Include files referenced by changed elements (ensures pasted images sync)
		// Even if we've "seen" the file, re-include it if its element changed
		for (const element of changedElements) {
			const fileId = element.fileId as string | undefined;
			if (fileId && files[fileId] && !newFiles[fileId]) {
				newFiles[fileId] = files[fileId];
			}
		}

		if (changedElements.length === 0 && Object.keys(newFiles).length === 0) {
			return; // No changes
		}

		// Accumulate pending updates (Map ensures only latest version per element)
		for (const element of changedElements) {
			this.pendingElements.set(element.id, element);
		}
		Object.assign(this.pendingFiles, newFiles);

		// Debounce
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}

		this.debounceTimer = setTimeout(() => {
			this.flush();
		}, this.config.debounceMs);
	}

	private flush(): void {
		if (this.pendingElements.size === 0 && Object.keys(this.pendingFiles).length === 0) {
			return;
		}

		const elements = Array.from(this.pendingElements.values());
		const files = this.pendingFiles;
		const basePayloadSize = JSON.stringify({ elements, seq: this.localSeq + 1 }).length;

		const hasFiles = Object.keys(files).length > 0;
		const batches =
			hasFiles && this.config.maxPayloadBytes > 0
				? this.splitFilesIntoBatches(files, basePayloadSize)
				: null;

		if (batches && batches.length > 0) {
			batches.forEach((batch, index) => {
				this.localSeq++;
				this.sendMessage("whiteboard.update", {
					elements: index === 0 ? elements : [],
					files: Object.keys(batch).length > 0 ? batch : undefined,
					seq: this.localSeq,
				});
			});
		} else {
			this.localSeq++;
			this.sendMessage("whiteboard.update", {
				elements,
				files: hasFiles && !batches ? files : undefined,
				seq: this.localSeq,
			});
		}

		this.pendingElements.clear();
		this.pendingFiles = {};
	}

	/**
	 * Send cursor position (throttled)
	 */
	sendCursor(x: number, y: number): void {
		const now = Date.now();
		if (now - this.lastCursorSend < this.config.cursorThrottleMs) {
			return;
		}
		this.lastCursorSend = now;

		this.sendMessage("whiteboard.cursor", { x, y });
	}

	/**
	 * Apply remote update to local state
	 * Returns merged elements array
	 */
	applyRemoteUpdate(
		currentElements: readonly ExcalidrawElement[],
		update: { elements: ExcalidrawElement[]; seq: number; participantId?: string },
	): ExcalidrawElement[] {
		const sourceKey = update.participantId ?? "__global__";
		const lastSeq = this.remoteSeqBySource.get(sourceKey) ?? 0;

		// Skip already-processed remote updates for this participant
		if (update.seq <= lastSeq) {
			return [...currentElements];
		}

		const elementMap = new Map(currentElements.map((e) => [e.id, e]));

		for (const element of update.elements) {
			if (element.isDeleted) {
				elementMap.delete(element.id);
			} else {
				// Use per-element versioning for conflict resolution
				const existing = elementMap.get(element.id);
				if (!existing || existing.version < element.version) {
					elementMap.set(element.id, element);
					// Update our tracking to avoid re-sending this element
					this.lastElements.set(element.id, element);
				}
			}
		}

		this.remoteSeqBySource.set(sourceKey, update.seq);
		return Array.from(elementMap.values());
	}

	/**
	 * Reset state (on room change or clear)
	 */
	reset(): void {
		this.lastElements.clear();
		this.lastFiles.clear();
		this.localSeq = 0;
		this.remoteSeqBySource.clear();
		this.pendingElements.clear();
		this.pendingFiles = {};
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
	}

	/**
	 * Load initial state from snapshot
	 */
	loadSnapshot(elements: readonly ExcalidrawElement[], seq: number): void {
		this.lastElements = new Map(elements.map((e) => [e.id, e]));
		this.remoteSeqBySource.clear();
		this.remoteSeqBySource.set("__global__", seq);
	}
}
