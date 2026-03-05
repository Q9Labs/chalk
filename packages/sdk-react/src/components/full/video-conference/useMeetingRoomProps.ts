import { useMemo } from "react";
import type { MeetingRoomProps } from "../MeetingRoom";

import type { ConferenceFeatureFlags } from "./useConferenceFeatureFlags";

export interface UseMeetingRoomPropsParams {
	roomName: MeetingRoomProps["roomName"];
	localParticipant: MeetingRoomProps["localParticipant"];
	participants: MeetingRoomProps["participants"];
	canManageParticipants: MeetingRoomProps["canManageParticipants"];
	handleToggleParticipantMute: NonNullable<MeetingRoomProps["onToggleParticipantMute"]>;
	handleRemoveParticipant: NonNullable<MeetingRoomProps["onRemoveParticipant"]>;
	activeReactions: NonNullable<MeetingRoomProps["activeReactions"]>;
	transcripts: NonNullable<MeetingRoomProps["transcripts"]>;
	isMuted: NonNullable<MeetingRoomProps["isMuted"]>;
	isVideoEnabled: NonNullable<MeetingRoomProps["isVideoEnabled"]>;
	isScreenSharing: NonNullable<MeetingRoomProps["isScreenSharing"]>;
	isHandRaised: NonNullable<MeetingRoomProps["isHandRaised"]>;
	isWhiteboardOpen: NonNullable<MeetingRoomProps["isWhiteboardOpen"]>;
	isRecording: NonNullable<MeetingRoomProps["isRecording"]>;
	recordingDuration: NonNullable<MeetingRoomProps["recordingDuration"]>;
	meetingDuration: NonNullable<MeetingRoomProps["meetingDuration"]>;
	featureFlags: ConferenceFeatureFlags;
	chatMessages: NonNullable<MeetingRoomProps["chatMessages"]>;
	unreadChatCount: NonNullable<MeetingRoomProps["unreadChatCount"]>;
	handleSendMessage: NonNullable<MeetingRoomProps["onSendMessage"]>;
	handleChatOpen: NonNullable<MeetingRoomProps["onChatOpen"]>;
	meetingLayout: NonNullable<MeetingRoomProps["defaultLayout"]>;
	defaultChatOpen: NonNullable<MeetingRoomProps["defaultChatOpen"]>;
	defaultParticipantsOpen: NonNullable<MeetingRoomProps["defaultParticipantsOpen"]>;
	handleToggleMute: NonNullable<MeetingRoomProps["onToggleMute"]>;
	handleToggleVideo: NonNullable<MeetingRoomProps["onToggleVideo"]>;
	handleToggleScreenShare: NonNullable<MeetingRoomProps["onToggleScreenShare"]>;
	handleToggleRecording: NonNullable<MeetingRoomProps["onToggleRecording"]>;
	handleToggleHandRaise: NonNullable<MeetingRoomProps["onToggleHandRaise"]>;
	handleToggleWhiteboard: NonNullable<MeetingRoomProps["onToggleWhiteboard"]>;
	handleSendReaction: NonNullable<MeetingRoomProps["onSendReaction"]>;
	handleLeave: NonNullable<MeetingRoomProps["onLeave"]>;
	onAddPeople: MeetingRoomProps["onAddPeople"];
	onWhiteboardExcalidrawApiReady: MeetingRoomProps["onWhiteboardExcalidrawApiReady"];
	participantVolumes: MeetingRoomProps["participantVolumes"];
	onParticipantVolumeChange: NonNullable<MeetingRoomProps["onParticipantVolumeChange"]>;
	getParticipantVolume: NonNullable<MeetingRoomProps["getParticipantVolume"]>;
	selectedAudioOutput: MeetingRoomProps["selectedAudioOutput"];
	connectionState: NonNullable<MeetingRoomProps["connectionState"]>;
	handleRetryConnection: NonNullable<MeetingRoomProps["onRetryConnection"]>;
	connectionSupportCode: MeetingRoomProps["connectionSupportCode"];
	className: MeetingRoomProps["className"];
}

export function useMeetingRoomProps({
	roomName,
	localParticipant,
	participants,
	canManageParticipants,
	handleToggleParticipantMute,
	handleRemoveParticipant,
	activeReactions,
	transcripts,
	isMuted,
	isVideoEnabled,
	isScreenSharing,
	isHandRaised,
	isWhiteboardOpen,
	isRecording,
	recordingDuration,
	meetingDuration,
	featureFlags,
	chatMessages,
	unreadChatCount,
	handleSendMessage,
	handleChatOpen,
	meetingLayout,
	defaultChatOpen,
	defaultParticipantsOpen,
	handleToggleMute,
	handleToggleVideo,
	handleToggleScreenShare,
	handleToggleRecording,
	handleToggleHandRaise,
	handleToggleWhiteboard,
	handleSendReaction,
	handleLeave,
	onAddPeople,
	onWhiteboardExcalidrawApiReady,
	participantVolumes,
	onParticipantVolumeChange,
	getParticipantVolume,
	selectedAudioOutput,
	connectionState,
	handleRetryConnection,
	connectionSupportCode,
	className,
}: UseMeetingRoomPropsParams): MeetingRoomProps {
	const { chat, recording, screenShare, handRaise, reactions, whiteboard, tour } =
		featureFlags;

	return useMemo(
		() => ({
			roomName,
			localParticipant,
			participants,
			canManageParticipants,
			onToggleParticipantMute: handleToggleParticipantMute,
			onRemoveParticipant: handleRemoveParticipant,
			activeReactions,
			transcripts,
			isMuted,
			isVideoEnabled,
			isScreenSharing,
			isHandRaised,
			isWhiteboardOpen,
			isRecording,
			recordingDuration,
			meetingDuration,
			canRecord: recording,
			chatMessages,
			unreadChatCount,
			onSendMessage: handleSendMessage,
			onChatOpen: handleChatOpen,
			enableChat: chat,
			enableRecording: recording,
			enableScreenShare: screenShare,
			enableHandRaise: handRaise,
			enableReactions: reactions,
			enableWhiteboard: whiteboard,
			enableTour: tour,
			defaultLayout: meetingLayout,
			defaultChatOpen,
			defaultParticipantsOpen,
			onToggleMute: handleToggleMute,
			onToggleVideo: handleToggleVideo,
			onToggleScreenShare: handleToggleScreenShare,
			onToggleRecording: handleToggleRecording,
			onToggleHandRaise: handleToggleHandRaise,
			onToggleWhiteboard: handleToggleWhiteboard,
			onSendReaction: handleSendReaction,
			onLeave: handleLeave,
			onAddPeople,
			onWhiteboardExcalidrawApiReady,
			participantVolumes,
			onParticipantVolumeChange,
			getParticipantVolume,
			selectedAudioOutput,
			connectionState,
			onRetryConnection: handleRetryConnection,
			connectionSupportCode,
			className,
		}),
		[
			roomName,
			localParticipant,
			participants,
			canManageParticipants,
			handleToggleParticipantMute,
			handleRemoveParticipant,
			activeReactions,
			transcripts,
			isMuted,
			isVideoEnabled,
			isScreenSharing,
			isHandRaised,
			isWhiteboardOpen,
			isRecording,
			recordingDuration,
			meetingDuration,
			chat,
			recording,
			screenShare,
			handRaise,
			reactions,
			whiteboard,
			tour,
			chatMessages,
			unreadChatCount,
			handleSendMessage,
			handleChatOpen,
			meetingLayout,
			defaultChatOpen,
			defaultParticipantsOpen,
			handleToggleMute,
			handleToggleVideo,
			handleToggleScreenShare,
			handleToggleRecording,
			handleToggleHandRaise,
			handleToggleWhiteboard,
			handleSendReaction,
			handleLeave,
			onAddPeople,
			onWhiteboardExcalidrawApiReady,
			participantVolumes,
			onParticipantVolumeChange,
			getParticipantVolume,
			selectedAudioOutput,
			connectionState,
			handleRetryConnection,
			connectionSupportCode,
			className,
		],
	);
}
