import type { ExcalidrawElement, BinaryFiles, WhiteboardConfig } from "./types";
import { DEFAULT_CONFIG } from "./types";

export type SendMessage = (type: string, payload: unknown) => void;

/**
 * SyncEngine handles delta updates and debouncing for whiteboard sync
 */
export class SyncEngine {
	private lastElements: Map<string, ExcalidrawElement> = new Map();
	private lastFiles: Set<string> = new Set();
	private seq = 0;
	private pendingUpdate: {
		elements: ExcalidrawElement[];
		files: BinaryFiles;
	} | null = null;
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

		if (changedElements.length === 0 && Object.keys(newFiles).length === 0) {
			return; // No changes
		}

		// Accumulate pending update
		if (this.pendingUpdate) {
			this.pendingUpdate.elements.push(...changedElements);
			Object.assign(this.pendingUpdate.files, newFiles);
		} else {
			this.pendingUpdate = {
				elements: changedElements,
				files: newFiles,
			};
		}

		// Debounce
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}

		this.debounceTimer = setTimeout(() => {
			this.flush();
		}, this.config.debounceMs);
	}

	private flush(): void {
		if (!this.pendingUpdate) return;

		this.seq++;

		this.sendMessage("whiteboard.update", {
			elements: this.pendingUpdate.elements,
			files:
				Object.keys(this.pendingUpdate.files).length > 0
					? this.pendingUpdate.files
					: undefined,
			seq: this.seq,
		});

		this.pendingUpdate = null;
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
		// Skip old updates
		if (update.seq <= this.seq) {
			return [...currentElements];
		}

		const elementMap = new Map(currentElements.map((e) => [e.id, e]));

		for (const element of update.elements) {
			if (element.isDeleted) {
				elementMap.delete(element.id);
			} else {
				// Remote wins for remote elements
				const existing = elementMap.get(element.id);
				if (!existing || existing.version <= element.version) {
					elementMap.set(element.id, element);
				}
			}
		}

		this.seq = update.seq;
		return Array.from(elementMap.values());
	}

	/**
	 * Reset state (on room change or clear)
	 */
	reset(): void {
		this.lastElements.clear();
		this.lastFiles.clear();
		this.seq = 0;
		this.pendingUpdate = null;
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
		this.seq = seq;
	}
}
