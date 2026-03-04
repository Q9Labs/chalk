/**
 * Optional PostHog session replay integration for Chalk SDK.
 *
 * No hard dependency on `posthog-js`:
 * pass any client implementing compatible methods.
 */

export interface ChalkPostHogClient {
	startSessionRecording?: () => void;
	stopSessionRecording?: () => void;
	capture?: (eventName: string, properties?: Record<string, unknown>) => void;
}

export interface ChalkPostHogConfig {
	/** Enable PostHog integration. @default true */
	enabled?: boolean;
	/** Initialized PostHog client instance (for example from `posthog-js`). */
	client: ChalkPostHogClient;
	/** Start replay when room join succeeds. @default true */
	startSessionRecordingOnJoin?: boolean;
	/** Stop replay when room is left/disconnected/switched. @default true */
	stopSessionRecordingOnLeave?: boolean;
	/** Emit lifecycle events to PostHog (`joined`, `join_failed`, `left`). @default true */
	captureLifecycleEvents?: boolean;
	/** Event name prefix. @default "chalk_sdk" */
	eventPrefix?: string;
	/** Extra properties attached to all lifecycle events. */
	properties?: Record<string, unknown>;
}

interface JoinSucceededInput {
	[key: string]: unknown;
	roomId: string;
	participantId: string;
	role: "host" | "participant";
	displayName: string;
	demoMode: boolean;
}

interface JoinFailedInput {
	[key: string]: unknown;
	roomId: string;
	displayName: string;
	error: string;
	demoMode: boolean;
}

interface LeaveInput {
	[key: string]: unknown;
	reason: "disconnect" | "switch_room";
	roomId?: string;
	participantId?: string;
	demoMode: boolean;
}

const DEFAULT_EVENT_PREFIX = "chalk_sdk";

const safely = (operation: () => void): void => {
	try {
		operation();
	} catch {
		// PostHog integration must never break SDK core flows.
	}
};

const mergeProperties = (
	base?: Record<string, unknown>,
	extra?: Record<string, unknown>,
): Record<string, unknown> | undefined => {
	if (!base && !extra) return undefined;
	if (!base) return { ...extra };
	if (!extra) return { ...base };
	return { ...base, ...extra };
};

/**
 * Lightweight bridge that maps Chalk room lifecycle to PostHog replay controls/events.
 */
export class ChalkPostHogSessionReplay {
	private config?: ChalkPostHogConfig;

	configure(config?: ChalkPostHogConfig): void {
		this.config = config;
	}

	trackJoinSucceeded(input: JoinSucceededInput): void {
		if (!this.isEnabled()) return;
		if (this.config?.startSessionRecordingOnJoin ?? true) {
			const start = this.config?.client.startSessionRecording;
			if (typeof start === "function") safely(() => start());
		}
		this.capture("session_joined", input);
	}

	trackJoinFailed(input: JoinFailedInput): void {
		if (!this.isEnabled()) return;
		this.capture("session_join_failed", input);
	}

	trackLeave(input: LeaveInput): void {
		if (!this.isEnabled()) return;
		this.capture("session_left", input);
		if (this.config?.stopSessionRecordingOnLeave ?? true) {
			const stop = this.config?.client.stopSessionRecording;
			if (typeof stop === "function") safely(() => stop());
		}
	}

	private isEnabled(): boolean {
		if (!this.config) return false;
		return this.config.enabled ?? true;
	}

	private capture(
		eventSuffix: string,
		properties?: Record<string, unknown>,
	): void {
		if (!this.config) return;
		if ((this.config.captureLifecycleEvents ?? true) === false) return;
		const capture = this.config.client.capture;
		if (typeof capture !== "function") return;
		const prefix = this.config.eventPrefix ?? DEFAULT_EVENT_PREFIX;
		const eventName = `${prefix}_${eventSuffix}`;
		const payload = mergeProperties(this.config.properties, properties);
		safely(() => capture(eventName, payload));
	}
}
