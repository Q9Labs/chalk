import { MessageSquare, Users, PenTool } from "lucide-react";
import { ControlButton } from "./ControlButton";
import {
	MicIcon,
	PhoneOffIcon,
	RecordIcon,
	ScreenShareIcon,
	SettingsIcon,
	VideoIcon,
} from "./icons";

export interface ControlBarProps {
	isAudioEnabled: boolean;
	isVideoEnabled: boolean;
	isScreenSharing: boolean;
	isRecording: boolean;
	onToggleAudio: () => void;
	onToggleVideo: () => void;
	onToggleScreenShare: () => void;
	onToggleRecording: () => void;
	onLeave: () => void;
	onToggleSettings?: () => void;
	roomId?: string;
	onToggleChat: () => void;
	onToggleParticipants: () => void;
	isChatOpen: boolean;
	isParticipantsOpen: boolean;
	participantCount: number;
	onToggleWhiteboard: () => void;
	isWhiteboardOpen: boolean;
}

export function ControlBar({
	isAudioEnabled,
	isVideoEnabled,
	isScreenSharing,
	isRecording,
	onToggleAudio,
	onToggleVideo,
	onToggleScreenShare,
	onToggleRecording,
	onLeave,
	onToggleSettings,
	roomId,
	onToggleChat,
	onToggleParticipants,
	isChatOpen,
	isParticipantsOpen,
	participantCount,
	onToggleWhiteboard,
	isWhiteboardOpen,
}: ControlBarProps) {
	const currentTime = new Date().toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
	});

	return (
		<div className="h-20 bg-[#202124] flex items-center justify-between px-6 shrink-0 z-50">
			{/* Left: Time and Room ID */}
			<div className="flex items-center gap-4 min-w-[200px]">
				<span className="text-white text-base font-medium">{currentTime}</span>
				<div className="w-px h-6 bg-white/20" />
				<span className="text-white/90 text-sm font-medium">
					{roomId || "Meeting"}
				</span>
			</div>

			{/* Center: Controls */}
			<div className="flex items-center gap-3">
				<ControlButton
					onClick={onToggleAudio}
					active={isAudioEnabled}
					label={isAudioEnabled ? "Turn off microphone" : "Turn on microphone"}
				>
					<MicIcon muted={!isAudioEnabled} />
				</ControlButton>

				<ControlButton
					onClick={onToggleVideo}
					active={isVideoEnabled}
					label={isVideoEnabled ? "Turn off camera" : "Turn on camera"}
				>
					<VideoIcon off={!isVideoEnabled} />
				</ControlButton>

				<ControlButton
					onClick={onToggleScreenShare}
					active={!isScreenSharing}
					label={isScreenSharing ? "Stop presenting" : "Present now"}
				>
					<ScreenShareIcon active={isScreenSharing} />
				</ControlButton>

				<ControlButton
					onClick={onToggleRecording}
					active={!isRecording}
					label={isRecording ? "Stop recording" : "Record meeting"}
				>
					<RecordIcon recording={isRecording} />
				</ControlButton>

				<ControlButton
					onClick={onToggleWhiteboard}
					active={!isWhiteboardOpen}
					label={isWhiteboardOpen ? "Close whiteboard" : "Open whiteboard"}
				>
					<PenTool className="w-5 h-5" />
				</ControlButton>

				<div className="ml-2">
					<ControlButton onClick={onLeave} danger label="Leave call">
						<PhoneOffIcon />
					</ControlButton>
				</div>
			</div>

			{/* Right: Info/More */}
			<div className="flex items-center justify-end gap-3 min-w-[200px]">
				<button
					type="button"
					onClick={onToggleSettings}
					className="p-2.5 rounded-full text-white hover:bg-[#3c4043] transition-colors"
					title="Settings"
				>
					<SettingsIcon />
				</button>

				<div className="w-px h-6 bg-white/20 mx-2" />

				<button
					type="button"
					onClick={onToggleChat}
					className={`p-2.5 rounded-full transition-colors relative ${isChatOpen ? "text-[#8ab4f8] bg-[#202124]" : "text-white hover:bg-[#3c4043]"}`}
					title="Chat with everyone"
				>
					<MessageSquare className="w-5 h-5" />
				</button>

				<button
					type="button"
					onClick={onToggleParticipants}
					className={`p-2.5 rounded-full transition-colors relative flex items-center justify-center ${isParticipantsOpen ? "text-[#8ab4f8] bg-[#202124]" : "text-white hover:bg-[#3c4043]"}`}
					title="Show everyone"
				>
					<Users className="w-5 h-5" />
					<span className="absolute -top-1 -right-1 bg-[#3c4043] text-xs px-1 rounded-full border border-[#202124] min-w-[18px] text-center">
						{participantCount}
					</span>
				</button>
			</div>
		</div>
	);
}
