import { useCallback } from "react";
import { MicIcon, ScreenShareIcon } from "./icons";

export interface ParticipantData {
	id: string;
	displayName: string;
	isLocal: boolean;
	videoEnabled: boolean;
	audioEnabled: boolean;
	videoTrack?: MediaStreamTrack;
	isSpeaking?: boolean;
	isScreenSharing?: boolean;
}

export interface ParticipantTileProps {
	participant: ParticipantData;
	isSpotlight?: boolean;
}

export function ParticipantTile({
	participant,
	isSpotlight = false,
}: ParticipantTileProps) {
	const videoRef = useCallback(
		(video: HTMLVideoElement | null) => {
			if (!video) return;
			if (participant.videoTrack && participant.videoEnabled) {
				const stream = new MediaStream([participant.videoTrack]);
				video.srcObject = stream;
				video.play().catch(() => {});
			} else {
				video.srcObject = null;
			}
		},
		[participant.videoTrack, participant.videoEnabled],
	);

	const getInitials = (name: string) =>
		name
			.split(" ")
			.map((n) => n[0])
			.join("")
			.toUpperCase()
			.slice(0, 2);

	const getAvatarColor = (name: string) => {
		const colors = [
			"bg-blue-600",
			"bg-purple-600",
			"bg-orange-600",
			"bg-emerald-600",
			"bg-pink-600",
			"bg-indigo-600",
			"bg-cyan-600",
		];
		const index = name
			.split("")
			.reduce((acc, char) => acc + char.charCodeAt(0), 0);
		return colors[index % colors.length];
	};

	return (
		<div
			className={`
        relative overflow-hidden rounded-xl
        bg-[#3c4043]
        transition-all duration-300 ease-out
        ${participant.isSpeaking ? "ring-2 ring-blue-500" : ""}
        group
      `}
			style={{ aspectRatio: isSpotlight ? "auto" : "16/9" }}
		>
			{/* Video element */}
			{participant.videoEnabled && participant.videoTrack ? (
				<video
					ref={videoRef}
					autoPlay
					playsInline
					muted={participant.isLocal}
					className={`w-full h-full object-cover ${participant.isLocal ? "scale-x-[-1]" : ""}`}
				/>
			) : (
				/* Avatar fallback */
				<div className="absolute inset-0 flex items-center justify-center">
					<div
						className={`
            w-24 h-24 rounded-full ${getAvatarColor(participant.displayName)}
            flex items-center justify-center text-3xl font-medium text-white
            shadow-sm
          `}
					>
						{getInitials(participant.displayName)}
					</div>
				</div>
			)}

			{/* Mute indicator (Top Right) */}
			{!participant.audioEnabled && (
				<div className="absolute top-3 right-3 w-8 h-8 rounded-full bg-black/60 flex items-center justify-center backdrop-blur-md">
					<MicIcon muted />
				</div>
			)}

			{/* Screen Share indicator (Top Left) */}
			{participant.isScreenSharing && (
				<div className="absolute top-3 left-3 w-8 h-8 rounded-full bg-blue-600/90 flex items-center justify-center backdrop-blur-md text-white">
					<ScreenShareIcon active />
				</div>
			)}

			{/* Name Tag (Bottom Left) */}
			<div className="absolute bottom-3 left-3 flex items-center gap-2 max-w-[calc(100%-24px)]">
				<div className="px-3 py-1.5 rounded-full bg-black/60 backdrop-blur-md flex items-center gap-2">
					<span className="text-sm font-medium text-white truncate max-w-[160px]">
						{participant.displayName}
						{participant.isLocal && " (You)"}
					</span>
				</div>
			</div>
		</div>
	);
}
