/**
 * UI state manager for Chalk SDK
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/managers
 */

import { StateContainer } from "../state/state-container";
import { TypedEventEmitter } from "../utils/typed-emitter";

/** Layout mode for video grid */
export type LayoutMode = "grid" | "spotlight" | "speaker" | "auto";

/** Side panel types */
export type PanelType =
	| "chat"
	| "participants"
	| "settings"
	| "whiteboard"
	| null;

/** Notification severity */
export type NotificationSeverity = "info" | "success" | "warning" | "error";

/** Notification item */
export interface Notification {
	id: string;
	message: string;
	severity: NotificationSeverity;
	timestamp: Date;
	autoDismiss?: boolean;
}

/** UI manager state */
export interface UIState {
	/** Current layout mode */
	readonly layout: LayoutMode;
	/** Currently open side panel */
	readonly activePanel: PanelType;
	/** Whether controls are visible */
	readonly controlsVisible: boolean;
	/** Active notifications */
	readonly notifications: readonly Notification[];
	/** Whether fullscreen is active */
	readonly isFullscreen: boolean;
	/** Whether in mobile view */
	readonly isMobileView: boolean;
}

/** UI manager events */
export interface UIManagerEvents {
	/** Layout changed */
	"layout:changed": { layout: LayoutMode };
	/** Panel opened/closed */
	"panel:changed": { panel: PanelType };
	/** Notification added */
	"notification:added": { notification: Notification };
	/** Notification dismissed */
	"notification:dismissed": { id: string };
}

const NOTIFICATION_DISMISS_MS = 5000;

/**
 * Manages UI state - layout, panels, notifications
 */
export class UIManager extends StateContainer<UIState> {
	private readonly events = new TypedEventEmitter<UIManagerEvents>();
	private notificationTimeouts = new Map<
		string,
		ReturnType<typeof setTimeout>
	>();
	private notifications: Notification[] = [];
	private controlsHideTimeout: ReturnType<typeof setTimeout> | null = null;
	// SDKCORE-MED-06: Store bound handler for proper cleanup
	private readonly boundDetectMobileView: () => void;

	constructor(_debug = false) {
		super({
			layout: "auto",
			activePanel: null,
			controlsVisible: true,
			notifications: [],
			isFullscreen: false,
			isMobileView: false,
		});

		// SDKCORE-MED-06: Bind once and store reference
		this.boundDetectMobileView = this.detectMobileView.bind(this);

		// Detect mobile on init
		if (typeof window !== "undefined") {
			this.detectMobileView();
			window.addEventListener("resize", this.boundDetectMobileView);
		}
	}

	/** Subscribe to UI events */
	on<K extends keyof UIManagerEvents>(
		event: K,
		handler: (data: UIManagerEvents[K]) => void,
	): () => void {
		return this.events.on(event, handler);
	}

	private detectMobileView(): void {
		const isMobile = window.innerWidth < 768;
		if (this.getState().isMobileView !== isMobile) {
			this.setState({ isMobileView: isMobile });
		}
	}

	/** Set layout mode */
	setLayout(layout: LayoutMode): void {
		this.setState({ layout });
		this.events.emit("layout:changed", { layout });
	}

	/** Toggle between grid and spotlight layout */
	toggleLayout(): void {
		const current = this.getState().layout;
		const next = current === "grid" ? "spotlight" : "grid";
		this.setLayout(next);
	}

	/** Open a side panel */
	openPanel(panel: PanelType): void {
		this.setState({ activePanel: panel });
		this.events.emit("panel:changed", { panel });
	}

	/** Close the current panel */
	closePanel(): void {
		this.setState({ activePanel: null });
		this.events.emit("panel:changed", { panel: null });
	}

	/** Toggle a panel (open if closed, close if open) */
	togglePanel(panel: Exclude<PanelType, null>): void {
		if (this.getState().activePanel === panel) {
			this.closePanel();
		} else {
			this.openPanel(panel);
		}
	}

	/** Add a notification */
	notify(
		message: string,
		severity: NotificationSeverity = "info",
		autoDismiss = true,
	): string {
		const notification: Notification = {
			id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
			message,
			severity,
			timestamp: new Date(),
			autoDismiss,
		};

		this.notifications.push(notification);
		this.setState({ notifications: [...this.notifications] });
		this.events.emit("notification:added", { notification });

		if (autoDismiss) {
			const timeout = setTimeout(() => {
				this.dismissNotification(notification.id);
			}, NOTIFICATION_DISMISS_MS);
			this.notificationTimeouts.set(notification.id, timeout);
		}

		return notification.id;
	}

	/** Dismiss a notification */
	dismissNotification(id: string): void {
		const timeout = this.notificationTimeouts.get(id);
		if (timeout) {
			clearTimeout(timeout);
			this.notificationTimeouts.delete(id);
		}

		this.notifications = this.notifications.filter((n) => n.id !== id);
		this.setState({ notifications: [...this.notifications] });
		this.events.emit("notification:dismissed", { id });
	}

	/** Clear all notifications */
	clearNotifications(): void {
		for (const timeout of this.notificationTimeouts.values()) {
			clearTimeout(timeout);
		}
		this.notificationTimeouts.clear();
		this.notifications = [];
		this.setState({ notifications: [] });
	}

	/** Show controls (with auto-hide after delay) */
	showControls(autoHideDelay?: number): void {
		if (this.controlsHideTimeout) {
			clearTimeout(this.controlsHideTimeout);
			this.controlsHideTimeout = null;
		}

		this.setState({ controlsVisible: true });

		if (autoHideDelay && autoHideDelay > 0) {
			this.controlsHideTimeout = setTimeout(() => {
				this.hideControls();
			}, autoHideDelay);
		}
	}

	/** Hide controls */
	hideControls(): void {
		if (this.controlsHideTimeout) {
			clearTimeout(this.controlsHideTimeout);
			this.controlsHideTimeout = null;
		}
		this.setState({ controlsVisible: false });
	}

	/** Toggle fullscreen mode */
	async toggleFullscreen(): Promise<void> {
		if (typeof document === "undefined") return;

		try {
			if (document.fullscreenElement) {
				await document.exitFullscreen();
				this.setState({ isFullscreen: false });
			} else {
				await document.documentElement.requestFullscreen();
				this.setState({ isFullscreen: true });
			}
		} catch {
			// Silently handle fullscreen errors
		}
	}

	/** Cleanup resources */
	dispose(): void {
		// Clear notification timeouts
		for (const timeout of this.notificationTimeouts.values()) {
			clearTimeout(timeout);
		}
		this.notificationTimeouts.clear();

		if (this.controlsHideTimeout) {
			clearTimeout(this.controlsHideTimeout);
		}

		// SDKCORE-MED-06: Remove resize listener using stored bound reference
		if (typeof window !== "undefined") {
			window.removeEventListener("resize", this.boundDetectMobileView);
		}

		this.events.removeAllListeners();
	}
}
