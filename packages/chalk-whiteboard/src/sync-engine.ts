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
	private remoteSeq = 0;
	private pendingElements: Map<string, ExcalidrawElement> = new Map();
	private pendingFiles: BinaryFiles = {};
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private lastCursorSend = 0;
	private readonly config: Required<WhiteboardConfig>;

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

		this.localSeq++;

		this.sendMessage("whiteboard.update", {
			elements: Array.from(this.pendingElements.values()),
			files:
				Object.keys(this.pendingFiles).length > 0
					? this.pendingFiles
					: undefined,
			seq: this.localSeq,
		});

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
		update: { elements: ExcalidrawElement[]; seq: number },
	): ExcalidrawElement[] {
		// Skip already-processed remote updates (prevents duplicate processing)
		if (update.seq <= this.remoteSeq) {
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

		this.remoteSeq = update.seq;
		return Array.from(elementMap.values());
	}

	/**
	 * Reset state (on room change or clear)
	 */
	reset(): void {
		this.lastElements.clear();
		this.lastFiles.clear();
		this.localSeq = 0;
		this.remoteSeq = 0;
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
		this.remoteSeq = seq;
	}
}
