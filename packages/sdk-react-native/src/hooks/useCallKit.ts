/**
 * useCallKit - iOS CallKit integration hook
 * Provides native call UI integration for iOS devices
 */

import { createLogger } from "@q9labs/chalk-core";
import { useCallback, useEffect, useState } from "react";
import {
	NativeEventEmitter,
	NativeModules,
	Platform,
} from "react-native";

const log = createLogger("useCallKit");

interface CallKitModuleType {
	reportIncomingCall: (
		uuid: string,
		handle: string,
		displayName: string,
		hasVideo: boolean,
	) => Promise<void>;
	reportOutgoingCall: (uuid: string, handle: string) => Promise<void>;
	reportCallConnected: (uuid: string) => Promise<void>;
	reportCallEnded: (
		uuid: string,
		reason: "failed" | "remoteEnded" | "unanswered" | "declinedElsewhere",
	) => Promise<void>;
	setCallMuted: (uuid: string, muted: boolean) => Promise<void>;
	setCallHeld: (uuid: string, held: boolean) => Promise<void>;
	endCall: (uuid: string) => Promise<void>;
	getActiveCalls: () => Promise<string[]>;
}

const CallKitModule =
	Platform.OS === "ios"
		? (NativeModules.CallKitModule as CallKitModuleType | undefined)
		: undefined;

export interface UseCallKitResult {
	/** Whether CallKit is available (iOS only) */
	isAvailable: boolean;
	/** Current active call UUID */
	activeCallId: string | null;
	/** Report an incoming call to show native UI */
	reportIncomingCall: (
		callId: string,
		callerName: string,
		hasVideo?: boolean,
	) => Promise<void>;
	/** Report an outgoing call */
	reportOutgoingCall: (callId: string) => Promise<void>;
	/** Report that the call has connected */
	reportCallConnected: (callId: string) => Promise<void>;
	/** Report that the call has ended */
	reportCallEnded: (
		callId: string,
		reason?: "failed" | "remoteEnded" | "unanswered" | "declinedElsewhere",
	) => Promise<void>;
	/** End the current call */
	endCall: (callId: string) => Promise<void>;
	/** Set mute state */
	setMuted: (callId: string, muted: boolean) => Promise<void>;
}

export function useCallKit(): UseCallKitResult {
	const [activeCallId, setActiveCallId] = useState<string | null>(null);

	const isAvailable = Platform.OS === "ios" && CallKitModule !== undefined;

	useEffect(() => {
		if (!isAvailable || !CallKitModule) {
			return;
		}

		const eventEmitter = new NativeEventEmitter(NativeModules.CallKitModule);

		const subscriptions = [
			eventEmitter.addListener("onCallAnswered", (event: { uuid: string }) => {
				log.debug("Call answered", event.uuid);
				setActiveCallId(event.uuid);
			}),
			eventEmitter.addListener("onCallEnded", (event: { uuid: string }) => {
				log.debug("Call ended", event.uuid);
				if (activeCallId === event.uuid) {
					setActiveCallId(null);
				}
			}),
			eventEmitter.addListener("onStartCall", (event: { uuid: string }) => {
				log.debug("Call started", event.uuid);
				setActiveCallId(event.uuid);
			}),
		];

		// Check for existing calls
		CallKitModule.getActiveCalls().then((calls) => {
			if (calls.length > 0) {
				setActiveCallId(calls[0] ?? null);
			}
		});

		return () => {
			for (const sub of subscriptions) {
				sub.remove();
			}
		};
	}, [isAvailable, activeCallId]);

	const reportIncomingCall = useCallback(
		async (callId: string, callerName: string, hasVideo = true) => {
			if (!CallKitModule) {
				log.warn("CallKit not available");
				return;
			}

			try {
				await CallKitModule.reportIncomingCall(
					callId,
					callId,
					callerName,
					hasVideo,
				);
				log.info("Reported incoming call", callId);
			} catch (err) {
				log.error("Failed to report incoming call", err);
				throw err;
			}
		},
		[],
	);

	const reportOutgoingCall = useCallback(async (callId: string) => {
		if (!CallKitModule) {
			log.warn("CallKit not available");
			return;
		}

		try {
			await CallKitModule.reportOutgoingCall(callId, callId);
			setActiveCallId(callId);
			log.info("Reported outgoing call", callId);
		} catch (err) {
			log.error("Failed to report outgoing call", err);
			throw err;
		}
	}, []);

	const reportCallConnected = useCallback(async (callId: string) => {
		if (!CallKitModule) {
			return;
		}

		try {
			await CallKitModule.reportCallConnected(callId);
			log.info("Reported call connected", callId);
		} catch (err) {
			log.error("Failed to report call connected", err);
			throw err;
		}
	}, []);

	const reportCallEnded = useCallback(
		async (
			callId: string,
			reason: "failed" | "remoteEnded" | "unanswered" | "declinedElsewhere" = "remoteEnded",
		) => {
			if (!CallKitModule) {
				return;
			}

			try {
				await CallKitModule.reportCallEnded(callId, reason);
				if (activeCallId === callId) {
					setActiveCallId(null);
				}
				log.info(`Reported call ended: ${callId} (${reason})`);
			} catch (err) {
				log.error("Failed to report call ended", err);
				throw err;
			}
		},
		[activeCallId],
	);

	const endCall = useCallback(
		async (callId: string) => {
			if (!CallKitModule) {
				return;
			}

			try {
				await CallKitModule.endCall(callId);
				if (activeCallId === callId) {
					setActiveCallId(null);
				}
				log.info("Ended call", callId);
			} catch (err) {
				log.error("Failed to end call", err);
				throw err;
			}
		},
		[activeCallId],
	);

	const setMuted = useCallback(async (callId: string, muted: boolean) => {
		if (!CallKitModule) {
			return;
		}

		try {
			await CallKitModule.setCallMuted(callId, muted);
			log.debug(`Set call muted: ${callId} (${muted})`);
		} catch (err) {
			log.error("Failed to set muted", err);
			throw err;
		}
	}, []);

	return {
		isAvailable,
		activeCallId,
		reportIncomingCall,
		reportOutgoingCall,
		reportCallConnected,
		reportCallEnded,
		endCall,
		setMuted,
	};
}
