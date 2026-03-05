import {
	ChalkErrorCode,
	wideEvents,
	type ChalkError,
	type JoinOptions,
	type Participant,
} from "@q9labs/chalk-core";
import { useCallback, useEffect, useRef, type MutableRefObject } from "react";

import { useChalkSession } from "../../../context/chalk-provider";
import type { SoundEffect } from "../../../hooks/useSoundEffects";
import type { JoinSettings } from "../PreJoinLobby";
import {
	inferJoinFailureStage,
	isTransientJoinFailure,
	toChalkError,
	waitMs,
} from "./join-errors";
import type { MeetingJoinedData, Phase } from "./types";

const JOIN_RETRY_DELAYS_MS = [500, 1200];

type JoinPhaseTransitionTarget = Phase | "failure";
type PostJoinDeviceSelectionKind = "camera" | "microphone" | "speaker";

export interface UseJoinFlowParams {
	roomId: string;
	role?: "host" | "participant";
	metadata?: Record<string, unknown>;
	join: (roomId: string, options: JoinOptions) => Promise<void>;
	isJoining: boolean;
	isConnected: boolean;
	localParticipant: Participant | null;
	isRecording: boolean;
	selectCamera: (deviceId: string) => Promise<void>;
	selectMicrophone: (deviceId: string) => Promise<void>;
	selectSpeaker: (deviceId: string) => Promise<void>;
	onJoin?: (data: MeetingJoinedData) => void;
	play: (name: SoundEffect) => void;
	emitError: (error: ChalkError, details?: Record<string, unknown>) => void;
	pushIncidentBreadcrumb: (
		category: string,
		message: string,
		data?: Record<string, unknown>,
	) => void;
	setPhase: (phase: Phase) => void;
	setError: (error: string | null) => void;
	setSupportCode: (supportCode: string | null) => void;
	phaseRef: MutableRefObject<Phase>;
	roomIdRef: MutableRefObject<string>;
}

export interface UseJoinFlowReturn {
	handleJoin: (settings: JoinSettings) => Promise<void>;
	handleRetryConnection: () => void;
}

export function useJoinFlow({
	roomId,
	role,
	metadata,
	join,
	isJoining,
	isConnected,
	localParticipant,
	isRecording,
	selectCamera,
	selectMicrophone,
	selectSpeaker,
	onJoin,
	play,
	emitError,
	pushIncidentBreadcrumb,
	setPhase,
	setError,
	setSupportCode,
	phaseRef,
	roomIdRef,
}: UseJoinFlowParams): UseJoinFlowReturn {
	const { session } = useChalkSession();
	const lastJoinSettingsRef = useRef<JoinSettings | null>(null);
	const joinInFlightRef = useRef(false);
	const preloadStartedRef = useRef(false);

	useEffect(() => {
		if (preloadStartedRef.current) {
			return;
		}
		preloadStartedRef.current = true;

		const chalkClient = (
			session as {
				chalkClient?: {
					preloadRealtimeKit?: () => Promise<boolean>;
				};
			}
		).chalkClient;
		const preloadRealtimeKit = chalkClient?.preloadRealtimeKit;
		if (typeof preloadRealtimeKit !== "function") {
			return;
		}

		void preloadRealtimeKit.call(chalkClient).then((succeeded: boolean) => {
			if (!succeeded) {
				pushIncidentBreadcrumb(
					"join",
					"RealtimeKit preload failed (will retry on join)",
					{ roomId },
				);
			}
		});
	}, [pushIncidentBreadcrumb, roomId, session]);

	const emitJoinClickTelemetry = useCallback(
		(settings: JoinSettings, data?: Record<string, unknown>) => {
			const ctx = wideEvents.start("ui.join.click");
			ctx.merge({
				roomId,
				phase: phaseRef.current,
				displayName: settings.displayName,
				audioEnabled: settings.audioEnabled,
				videoEnabled: settings.videoEnabled,
				selectedVideoDevice: settings.selectedVideoDevice,
				selectedAudioInput: settings.selectedAudioInput,
				selectedAudioOutput: settings.selectedAudioOutput,
				...(data ?? {}),
			});
			ctx.complete("success");
		},
		[phaseRef, roomId],
	);

	const emitJoinPhaseTransitionTelemetry = useCallback(
		(
			fromPhase: Phase,
			toPhase: JoinPhaseTransitionTarget,
			data?: Record<string, unknown>,
			errorForTelemetry?: ChalkError,
		) => {
			const ctx = wideEvents.start("ui.join.phase_transition");
			ctx.merge({
				roomId,
				fromPhase,
				toPhase,
				transition: `${fromPhase}->${toPhase}`,
				...(data ?? {}),
			});
			if (toPhase === "failure") {
				ctx.complete(
					"error",
					errorForTelemetry ?? {
						code: ChalkErrorCode.UNKNOWN_ERROR,
						message: "Join failed",
					},
				);
				return;
			}
			ctx.complete("success");
		},
		[roomId],
	);

	const selectMediaDevicePostJoin = useCallback(
		async (
			deviceKind: PostJoinDeviceSelectionKind,
			deviceId: string,
			select: (id: string) => Promise<void>,
		): Promise<void> => {
			const ctx = wideEvents.start("ui.media.device_selection");
			ctx.merge({
				roomId,
				deviceKind,
				deviceId,
				trigger: "post_join_click",
			});
			ctx.markPhase("select_device");
			const startedAt = performance.now();

			try {
				await select(deviceId);
				ctx.complete("success", {
					outcome: "selected",
					durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
				});
			} catch (rawError) {
				const chalkError = toChalkError(rawError);
				ctx.set("outcome", "failed");
				ctx.set("durationMs", Math.max(0, Math.round(performance.now() - startedAt)));
				ctx.complete("error", chalkError);
				pushIncidentBreadcrumb("media", "Post-click media device selection failed", {
					deviceKind,
					deviceId,
					code: chalkError.code,
					message: chalkError.message,
				});
			}
		},
		[pushIncidentBreadcrumb, roomId],
	);

	const handleJoin = useCallback(
		async (settings: JoinSettings) => {
			emitJoinClickTelemetry(settings);
			if (joinInFlightRef.current || isJoining || isConnected) {
				if (isConnected) {
					const fromPhase = phaseRef.current;
					setPhase("meeting");
					emitJoinPhaseTransitionTelemetry(fromPhase, "meeting", {
						reason: "already_connected_guard",
					});
				}
				pushIncidentBreadcrumb("join", "Join skipped (already in-flight or connected)", {
					isConnected,
					isJoining,
				});
				return;
			}
			joinInFlightRef.current = true;

			try {
				lastJoinSettingsRef.current = settings;
				const fromPhase = phaseRef.current;
				setPhase("joining");
				emitJoinPhaseTransitionTelemetry(fromPhase, "joining", {
					reason: "join_clicked",
				});
				setError(null);
				setSupportCode(null);

				const maxAttempts = JOIN_RETRY_DELAYS_MS.length + 1;
				let finalError: ChalkError | null = null;

				for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
					pushIncidentBreadcrumb("join", "Join attempt started", {
						attempt: attempt + 1,
						maxAttempts,
						roomId,
					});
					try {
						await join(roomId, {
							userName: settings.displayName,
							role,
							videoEnabled: settings.videoEnabled,
							audioEnabled: settings.audioEnabled,
							metadata,
						});

						const deviceSelectionTasks: Promise<void>[] = [];
						if (settings.selectedVideoDevice) {
							deviceSelectionTasks.push(
								selectMediaDevicePostJoin(
									"camera",
									settings.selectedVideoDevice,
									selectCamera,
								),
							);
						}
						if (settings.selectedAudioInput) {
							deviceSelectionTasks.push(
								selectMediaDevicePostJoin(
									"microphone",
									settings.selectedAudioInput,
									selectMicrophone,
								),
							);
						}
						if (settings.selectedAudioOutput) {
							deviceSelectionTasks.push(
								selectMediaDevicePostJoin(
									"speaker",
									settings.selectedAudioOutput,
									selectSpeaker,
								),
							);
						}

						setPhase("meeting");
						emitJoinPhaseTransitionTelemetry("joining", "meeting", {
							reason: "join_succeeded",
							attempt: attempt + 1,
							maxAttempts,
						});
						if (deviceSelectionTasks.length > 0) {
							void Promise.allSettled(deviceSelectionTasks);
						}
						pushIncidentBreadcrumb("join", "Join attempt succeeded", {
							attempt: attempt + 1,
							maxAttempts,
							roomId,
						});
						play("join");
						onJoin?.({
							roomId,
							participantId: localParticipant?.id ?? "",
							role: localParticipant?.role ?? role ?? "participant",
							displayName: settings.displayName,
							isRecording,
							joinedAt: new Date(),
						});
						return;
					} catch (rawError) {
						const chalkError = toChalkError(rawError);
						if (chalkError.message?.includes("Already connected")) {
							setPhase("meeting");
							emitJoinPhaseTransitionTelemetry("joining", "meeting", {
								reason: "already_connected_error",
								attempt: attempt + 1,
								maxAttempts,
							});
							return;
						}
						if (chalkError.message?.includes("Already joining a room")) {
							pushIncidentBreadcrumb(
								"join",
								"Join request deduped (already joining)",
								{
									attempt: attempt + 1,
									maxAttempts,
									roomId,
								},
							);
							return;
						}

						const joinStage = inferJoinFailureStage(chalkError);
						const retryable = isTransientJoinFailure(chalkError, joinStage);
						const enrichedError: ChalkError = {
							...chalkError,
							details: {
								...(chalkError.details ?? {}),
								stage: joinStage,
								attempt: attempt + 1,
								maxAttempts,
								retryable,
							},
						};
						finalError = enrichedError;
						pushIncidentBreadcrumb("join", "Join attempt failed", {
							attempt: attempt + 1,
							maxAttempts,
							roomId,
							stage: joinStage,
							retryable,
							code: enrichedError.code,
							message: enrichedError.message,
						});

						if (!retryable || attempt >= maxAttempts - 1) {
							break;
						}

						await waitMs(JOIN_RETRY_DELAYS_MS[attempt] ?? 0);
					}
				}

				const terminalError: ChalkError =
					finalError ?? {
						code: ChalkErrorCode.UNKNOWN_ERROR,
						message: "Failed to join room",
					};
				setError(terminalError.message || "Failed to join room");
				emitError(terminalError, {
					event: "join_failed",
					joinRetryExhausted: true,
					joinStage:
						typeof terminalError.details?.stage === "string"
							? terminalError.details.stage
							: undefined,
				});
				emitJoinPhaseTransitionTelemetry(
					"joining",
					"failure",
					{
						reason: "join_failed",
						maxAttempts,
					},
					terminalError,
				);
				setPhase("lobby");
			} finally {
				joinInFlightRef.current = false;
			}
		},
		[
			emitJoinClickTelemetry,
			emitJoinPhaseTransitionTelemetry,
			isJoining,
			isConnected,
			pushIncidentBreadcrumb,
			phaseRef,
			setPhase,
			setError,
			setSupportCode,
			roomId,
			join,
			role,
			metadata,
			selectMediaDevicePostJoin,
			selectCamera,
			selectMicrophone,
			selectSpeaker,
			play,
			onJoin,
			localParticipant,
			isRecording,
			emitError,
		],
	);

	const handleRetryConnection = useCallback(() => {
		const previousJoinSettings = lastJoinSettingsRef.current;
		if (!previousJoinSettings) {
			setError("Connection lost. Please retry from the lobby.");
			setSupportCode(null);
			setPhase("lobby");
			return;
		}
		pushIncidentBreadcrumb("join", "User retried connection from lobby CTA", {
			roomId: roomIdRef.current,
		});
		void handleJoin(previousJoinSettings);
	}, [handleJoin, pushIncidentBreadcrumb, roomIdRef, setError, setPhase, setSupportCode]);

	return {
		handleJoin,
		handleRetryConnection,
	};
}
