import type React from "react";
import { memo, useCallback, useEffect, useMemo, useRef } from "react";

import { SettingsDialog } from "../composite/SettingsDialog";
import { useMeetingRoomSettings } from "../../hooks/useMeetingRoomSettings";
import { useDraggable } from "../../hooks/ui/useDraggable";
import { useIsMobile } from "../../hooks/useMediaQuery";
import { cn } from "../../utils/cn";
import { getParticipantThemeVariables } from "../../utils/colorGenerator";
import { MeetingRoomControls } from "./meeting-room/MeetingRoomControls";
import { MeetingRoomOverlays } from "./meeting-room/MeetingRoomOverlays";
import { MeetingRoomPanels } from "./meeting-room/MeetingRoomPanels";
import { MeetingRoomStage } from "./meeting-room/MeetingRoomStage";
import { MeetingRoomTopBar } from "./meeting-room/MeetingRoomTopBar";
import type { MeetingLayout, MeetingRoomProps } from "./meeting-room/types";
import { useMeetingRoomDerived } from "./meeting-room/useMeetingRoomDerived";
import { useMeetingRoomLifecycle } from "./meeting-room/useMeetingRoomLifecycle";
import { useMeetingRoomTheme } from "./meeting-room/useMeetingRoomTheme";
import { useMeetingRoomUiState } from "./meeting-room/useMeetingRoomUiState";

function MeetingRoomBase({
	roomName,
	localParticipant,
	participants,
	canManageParticipants = false,
	onToggleParticipantMute,
	onRemoveParticipant,
	onUpdateDisplayName,
	activeReactions = [],
	isMuted = false,
	isVideoEnabled = false,
	isScreenSharing = false,
	isHandRaised = false,
	isWhiteboardOpen = false,
	isRecording = false,
	recordingDuration: _recordingDuration = 0,
	meetingDuration = 0,
	canRecord = false,
	transcripts = [],
	chatMessages = [],
	unreadChatCount = 0,
	onSendMessage,
	onSendMessageWithAttachments,
	onResolveChatAttachmentUrl,
	onChatOpen,
	enableChat = true,
	enableRecording = true,
	enableScreenShare = true,
	enableHandRaise = true,
	enableReactions = true,
	enableWhiteboard = true,
	enableTranscription = true,
	enableTour = true,
	defaultLayout = "grid",
	defaultChatOpen = false,
	defaultParticipantsOpen = false,
	defaultTranscriptionOpen = false,
	showTourOnFirstVisit = true,
	showInviteToastOnJoin = true,
	onToggleMute,
	onToggleVideo,
	onAudioInputChange,
	onAudioOutputChange,
	onVideoInputChange,
	onToggleScreenShare,
	onToggleRecording,
	onToggleHandRaise,
	onToggleWhiteboard,
	onSendReaction,
	onToggleTranscription,
	onLeave,
	onTourComplete,
	onAddPeople,
	connectionState = "connected",
	onRetryConnection,
	connectionSupportCode,
	audioInputDevices = [],
	audioOutputDevices = [],
	videoInputDevices = [],
	selectedAudioInput,
	participantVolumes,
	onParticipantVolumeChange,
	getParticipantVolume,
	selectedAudioOutput,
	selectedVideoInput,
	theme = "system",
	onWhiteboardExcalidrawApiReady,
	className,
}: MeetingRoomProps): React.JSX.Element {
	const isMobile = useIsMobile();
	const containerRef = useRef<HTMLDivElement>(null);
	const pillRef = useRef<HTMLDivElement>(null);
	const didHydrateDevicePreferencesRef = useRef(false);
	const { dragHandlers: pillDragHandlers } = useDraggable(pillRef, {
		boundaryRef: containerRef,
		snapToCorners: true,
		cornerMargin: 24,
		bounce: 0.2,
		friction: 0.94,
	});

	const settingsDefaults = useMemo(
		() => ({
			appearance: {
				layout: defaultLayout,
				theme,
				showFilmstrip: true,
				reducedMotion: false,
			},
			experience: {
				showInviteToast: showInviteToastOnJoin,
				defaultOpenChat: defaultChatOpen,
				defaultOpenParticipants: defaultParticipantsOpen,
				defaultOpenTranscription: defaultTranscriptionOpen,
			},
		}),
		[
			defaultChatOpen,
			defaultLayout,
			defaultParticipantsOpen,
			defaultTranscriptionOpen,
			showInviteToastOnJoin,
			theme,
		],
	);

	const {
		settings,
		updateAudioSettings,
		updateVideoSettings,
		updateAppearanceSettings,
		updateExperienceSettings,
	} = useMeetingRoomSettings({
		defaults: settingsDefaults,
	});

	const ui = useMeetingRoomUiState({
		defaultChatOpen: settings.experience.defaultOpenChat,
		defaultParticipantsOpen: settings.experience.defaultOpenParticipants,
		defaultTranscriptionOpen: settings.experience.defaultOpenTranscription,
		defaultLayout: settings.appearance.layout,
		defaultFilmstripOpen: settings.appearance.showFilmstrip,
		showInviteToastOnJoin: settings.experience.showInviteToast,
		onChatOpen,
	});

	const roomTheme = settings.appearance.theme;
	const reduceMotion = settings.appearance.reducedMotion;
	const { isDarkMode } = useMeetingRoomTheme({ theme: roomTheme });
	const { handleTourComplete, handleCopyLink } = useMeetingRoomLifecycle({
		enableTour,
		showTourOnFirstVisit,
		defaultChatOpen,
		onChatOpen,
		onToggleMute,
		onToggleVideo,
		onLeave,
		onTourComplete,
		setShowTour: ui.setShowTour,
		setIsExiting: ui.setIsExiting,
	});
	const { allParticipants, screenSharer, isSplit, isStageMode } =
		useMeetingRoomDerived({
			participants,
			localParticipant,
			isMobile,
			enableWhiteboard,
			isWhiteboardOpen,
		});
	const participantColorSeed =
		localParticipant.displayName || localParticipant.id;

	useEffect(() => {
		if (didHydrateDevicePreferencesRef.current) {
			return;
		}

		if (
			audioInputDevices.length === 0 &&
			audioOutputDevices.length === 0 &&
			videoInputDevices.length === 0 &&
			!selectedAudioInput &&
			!selectedAudioOutput &&
			!selectedVideoInput
		) {
			return;
		}

		didHydrateDevicePreferencesRef.current = true;

		const audioUpdates: Partial<typeof settings.audio> = {};
		const videoUpdates: Partial<typeof settings.video> = {};

		if (settings.audio.selectedInput) {
			if (
				settings.audio.selectedInput !== selectedAudioInput &&
				audioInputDevices.some(
					(device) => device.deviceId === settings.audio.selectedInput,
				)
			) {
				onAudioInputChange?.(settings.audio.selectedInput);
			}
		} else if (selectedAudioInput) {
			audioUpdates.selectedInput = selectedAudioInput;
		}

		if (settings.audio.selectedOutput) {
			if (
				settings.audio.selectedOutput !== selectedAudioOutput &&
				audioOutputDevices.some(
					(device) => device.deviceId === settings.audio.selectedOutput,
				)
			) {
				onAudioOutputChange?.(settings.audio.selectedOutput);
			}
		} else if (selectedAudioOutput) {
			audioUpdates.selectedOutput = selectedAudioOutput;
		}

		if (settings.video.selectedInput) {
			if (
				settings.video.selectedInput !== selectedVideoInput &&
				videoInputDevices.some(
					(device) => device.deviceId === settings.video.selectedInput,
				)
			) {
				onVideoInputChange?.(settings.video.selectedInput);
			}
		} else if (selectedVideoInput) {
			videoUpdates.selectedInput = selectedVideoInput;
		}

		if (Object.keys(audioUpdates).length > 0) {
			updateAudioSettings(audioUpdates);
		}

		if (Object.keys(videoUpdates).length > 0) {
			updateVideoSettings(videoUpdates);
		}
	}, [
		audioInputDevices,
		audioOutputDevices,
		onAudioInputChange,
		onAudioOutputChange,
		onVideoInputChange,
		selectedAudioInput,
		selectedAudioOutput,
		selectedVideoInput,
		settings.audio.selectedInput,
		settings.audio.selectedOutput,
		settings.video.selectedInput,
		updateAudioSettings,
		updateVideoSettings,
		videoInputDevices,
	]);

	const handleAddPeople = useCallback(() => {
		ui.setShowInviteModal(true);
		onAddPeople?.();
	}, [onAddPeople, ui.setShowInviteModal]);

	const handleLayoutChange = useCallback(
		(nextLayout: MeetingLayout) => {
			ui.setLayout(nextLayout);
			updateAppearanceSettings({ layout: nextLayout });
		},
		[ui.setLayout, updateAppearanceSettings],
	);

	const handleFilmstripToggle = useCallback(() => {
		const nextValue = !ui.isFilmstripOpen;
		ui.setIsFilmstripOpen(nextValue);
		updateAppearanceSettings({ showFilmstrip: nextValue });
	}, [ui.isFilmstripOpen, ui.setIsFilmstripOpen, updateAppearanceSettings]);

	const handleThemeToggle = useCallback(() => {
		updateAppearanceSettings({
			theme: settings.appearance.theme === "dark" ? "light" : "dark",
		});
	}, [settings.appearance.theme, updateAppearanceSettings]);

	const handleAudioInputPreference = useCallback(
		(deviceId: string) => {
			onAudioInputChange?.(deviceId);
		},
		[onAudioInputChange],
	);

	const handleAudioOutputPreference = useCallback(
		(deviceId: string) => {
			onAudioOutputChange?.(deviceId);
		},
		[onAudioOutputChange],
	);

	const handleVideoInputPreference = useCallback(
		(deviceId: string) => {
			onVideoInputChange?.(deviceId);
		},
		[onVideoInputChange],
	);

	const handleExperienceSettings = useCallback(
		(updates: Partial<typeof settings.experience>) => {
			if (updates.showInviteToast === false) {
				ui.setShowInviteToast(false);
			}
			updateExperienceSettings(updates);
		},
		[ui.setShowInviteToast, updateExperienceSettings],
	);

	const effectiveGetParticipantVolume = useCallback(
		(participantId: string) => {
			const baseVolume = getParticipantVolume?.(participantId) ?? 1;
			return Math.max(
				0,
				Math.min(1, baseVolume * (settings.audio.outputVolume / 100)),
			);
		},
		[getParticipantVolume, settings.audio.outputVolume],
	);

	return (
		<div
			ref={containerRef}
			data-chalk
			className={cn(
				"chalk-root chalk-theme-transition relative flex h-screen w-full flex-col overflow-hidden bg-background text-foreground",
				isMobile ? "p-2" : "p-0",
				className,
			)}
			data-chalk-theme={roomTheme === "system" ? undefined : roomTheme}
			style={getParticipantThemeVariables(
				participantColorSeed,
			) as React.CSSProperties}
		>
			<div
				className={cn(
					"absolute inset-0 pointer-events-none z-0 overflow-hidden",
					!reduceMotion &&
						"animate-out fade-out duration-[7000ms] delay-[4000ms] fill-mode-forwards",
					isDarkMode ? "mix-blend-screen" : "mix-blend-multiply",
				)}
			>
				<div
					className={cn(
						"absolute -left-[25vw] -top-[25vh] h-[150vh] w-[150vw] opacity-40 dark:opacity-20",
						!reduceMotion && "animate-[spin_15s_linear_infinite]",
					)}
					style={{
						background:
							"radial-gradient(ellipse at 40% 40%, var(--primary) 0%, transparent 60%)",
						filter: "blur(100px)",
					}}
				/>
				<div
					className={cn(
						"absolute -left-[25vw] -top-[25vh] h-[150vh] w-[150vw] opacity-30 dark:opacity-10",
						!reduceMotion &&
							"animate-[spin_20s_linear_infinite_reverse]",
					)}
					style={{
						background:
							"radial-gradient(ellipse at 60% 60%, var(--accent) 0%, transparent 60%)",
						filter: "blur(120px)",
					}}
				/>
			</div>

			<div
				className={cn(
					"relative z-10 w-full",
					!reduceMotion &&
						"animate-in fade-in slide-in-from-top-4 duration-700 ease-out fill-mode-both delay-100",
				)}
			>
				<MeetingRoomTopBar
					isMobile={isMobile}
					roomName={roomName}
					activePanel={ui.activePanel}
					layout={ui.layout}
					setLayout={handleLayoutChange}
					isDarkMode={isDarkMode}
					onToggleTheme={handleThemeToggle}
					pillRef={pillRef}
					pillDragHandlers={pillDragHandlers}
				/>
			</div>

			<div
				className={cn(
					"relative z-0 flex min-h-0 flex-1 flex-row overflow-hidden",
					!reduceMotion &&
						"animate-in fade-in zoom-in-[0.98] duration-1000 ease-out fill-mode-both",
					isMobile ? "gap-2 pt-2" : "gap-4 px-4 pt-4",
					ui.isExiting && "pointer-events-none",
				)}
			>
				<MeetingRoomStage
					isMobile={isMobile}
					layout={ui.layout}
					isStageMode={isStageMode}
					isSplit={isSplit}
					screenSharer={screenSharer}
					allParticipants={allParticipants}
					isFilmstripOpen={ui.isFilmstripOpen}
					onToggleFilmstrip={handleFilmstripToggle}
					enableWhiteboard={enableWhiteboard}
					isWhiteboardOpen={isWhiteboardOpen}
					theme={roomTheme}
					onWhiteboardExcalidrawApiReady={onWhiteboardExcalidrawApiReady}
					activeReactions={activeReactions}
					isExiting={ui.isExiting}
					localParticipantColorSeed={participantColorSeed}
				/>

				<MeetingRoomPanels
					isMobile={isMobile}
					activePanel={ui.activePanel}
					onClosePanel={() => ui.setActivePanel(null)}
					allParticipants={allParticipants}
					canManageParticipants={canManageParticipants}
					onToggleParticipantMute={onToggleParticipantMute}
					onRemoveParticipant={onRemoveParticipant}
					onUpdateDisplayName={onUpdateDisplayName}
					onAddPeople={handleAddPeople}
					chatMessages={chatMessages}
					onSendMessage={onSendMessage}
					onSendMessageWithAttachments={onSendMessageWithAttachments}
					onResolveChatAttachmentUrl={onResolveChatAttachmentUrl}
					transcripts={transcripts}
					participantVolumes={participantVolumes}
					onParticipantVolumeChange={onParticipantVolumeChange}
					localParticipantColorSeed={participantColorSeed}
				/>
			</div>

			<div
				className={cn(
					"relative z-10 w-full",
					!reduceMotion &&
						"animate-in fade-in slide-in-from-bottom-8 duration-700 ease-out fill-mode-both delay-300",
				)}
			>
				<MeetingRoomControls
					isMobile={isMobile}
					activePanel={ui.activePanel}
					onTogglePanel={ui.togglePanel}
					isMobileSheetOpen={ui.isMobileSheetOpen}
					setIsMobileSheetOpen={ui.setIsMobileSheetOpen}
					isReactionPickerOpen={ui.isReactionPickerOpen}
					setIsReactionPickerOpen={ui.setIsReactionPickerOpen}
					isMuted={isMuted}
					isVideoEnabled={isVideoEnabled}
					isScreenSharing={isScreenSharing}
					isHandRaised={isHandRaised}
					isWhiteboardOpen={isWhiteboardOpen}
					isRecording={isRecording}
					meetingDuration={meetingDuration}
					unreadChatCount={unreadChatCount}
					canRecord={canRecord}
					enableScreenShare={enableScreenShare}
					enableRecording={enableRecording}
					enableHandRaise={enableHandRaise}
					enableReactions={enableReactions}
					enableWhiteboard={enableWhiteboard}
					enableTranscription={enableTranscription}
					enableChat={enableChat}
					audioInputDevices={audioInputDevices}
					audioOutputDevices={audioOutputDevices}
					videoInputDevices={videoInputDevices}
					selectedAudioInput={selectedAudioInput ?? settings.audio.selectedInput}
					selectedAudioOutput={selectedAudioOutput ?? settings.audio.selectedOutput}
					selectedVideoInput={selectedVideoInput ?? settings.video.selectedInput}
					onToggleMute={onToggleMute}
					onToggleVideo={onToggleVideo}
					onAudioInputChange={handleAudioInputPreference}
					onAudioOutputChange={handleAudioOutputPreference}
					onVideoInputChange={handleVideoInputPreference}
					onToggleScreenShare={onToggleScreenShare}
					onToggleRecording={onToggleRecording}
					onToggleHandRaise={onToggleHandRaise}
					onToggleWhiteboard={onToggleWhiteboard}
					onToggleTranscription={onToggleTranscription}
					onSendReaction={onSendReaction}
					onLeave={onLeave}
					onOpenSettings={() => ui.setIsSettingsOpen(true)}
					isExiting={ui.isExiting}
					localParticipantColorSeed={participantColorSeed}
				/>
			</div>

			<MeetingRoomOverlays
				connectionState={connectionState}
				onRetryConnection={onRetryConnection}
				connectionSupportCode={connectionSupportCode}
				enableTour={enableTour}
				showTour={ui.showTour}
				onTourComplete={handleTourComplete}
				showInviteModal={ui.showInviteModal}
				setShowInviteModal={ui.setShowInviteModal}
				showInviteToast={ui.showInviteToast}
				setShowInviteToast={ui.setShowInviteToast}
				isMobile={isMobile}
				roomName={roomName}
				onCopyLink={handleCopyLink}
				allParticipants={allParticipants}
				getParticipantVolume={effectiveGetParticipantVolume}
				selectedAudioOutput={selectedAudioOutput ?? settings.audio.selectedOutput}
			/>

			<SettingsDialog
				isOpen={ui.isSettingsOpen}
				onClose={() => ui.setIsSettingsOpen(false)}
				settings={settings}
				onUpdateAudio={(updates) => {
					updateAudioSettings(updates);
					if (updates.selectedInput) {
						handleAudioInputPreference(updates.selectedInput);
					}
					if (updates.selectedOutput) {
						handleAudioOutputPreference(updates.selectedOutput);
					}
				}}
				onUpdateVideo={(updates) => {
					updateVideoSettings(updates);
					if (updates.selectedInput) {
						handleVideoInputPreference(updates.selectedInput);
					}
				}}
				onUpdateAppearance={(updates) => {
					updateAppearanceSettings(updates);
					if (updates.layout) {
						ui.setLayout(updates.layout);
					}
					if (typeof updates.showFilmstrip === "boolean") {
						ui.setIsFilmstripOpen(updates.showFilmstrip);
					}
				}}
				onUpdateExperience={handleExperienceSettings}
				audioInputDevices={audioInputDevices}
				audioOutputDevices={audioOutputDevices}
				videoInputDevices={videoInputDevices}
				audioLevel={0}
				videoTrack={localParticipant.videoTrack}
				reducedMotion={reduceMotion}
				participantColorSeed={participantColorSeed}
			/>
		</div>
	);
}

export type {
	ActiveReaction,
	ChatMessage,
	MeetingPanel,
	Participant,
	TranscriptEntry,
	MeetingRoomProps,
} from "./meeting-room/types";

export const MeetingRoom = memo(MeetingRoomBase);
MeetingRoom.displayName = "MeetingRoom";

export default MeetingRoom;
