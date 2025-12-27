import { ControlButton } from "./ControlButton";
import {
	MicIcon,
	PhoneOffIcon,
	RecordIcon,
	ScreenShareIcon,
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
}: ControlBarProps) {
	return (
		<div className="absolute bottom-6 left-1/2 -translate-x-1/2">
			<div
				className="
        flex items-center gap-2 px-4 py-3
        bg-slate-900/80 backdrop-blur-xl
        border border-white/10
        rounded-2xl
        shadow-2xl shadow-black/40
      "
			>
				<ControlButton
					onClick={onToggleAudio}
					active={isAudioEnabled}
					label={isAudioEnabled ? "Mute microphone" : "Unmute microphone"}
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

				<div className="w-px h-8 bg-slate-700/50 mx-1" />

				<ControlButton
					onClick={() =>
						isScreenSharing ? onToggleScreenShare() : onToggleScreenShare()
					}
					active={!isScreenSharing}
					label={isScreenSharing ? "Stop sharing" : "Share screen"}
				>
					<ScreenShareIcon active={isScreenSharing} />
				</ControlButton>

				<ControlButton
					onClick={() =>
						isRecording ? onToggleRecording() : onToggleRecording()
					}
					active={!isRecording}
					label={isRecording ? "Stop recording" : "Start recording"}
				>
					<RecordIcon recording={isRecording} />
				</ControlButton>

				<div className="w-px h-8 bg-slate-700/50 mx-1" />

				<ControlButton onClick={onLeave} danger label="Leave call">
					<PhoneOffIcon />
				</ControlButton>
			</div>
		</div>
	);
}
