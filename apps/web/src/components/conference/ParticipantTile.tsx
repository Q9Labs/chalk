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
			"from-cyan-500 to-teal-600",
			"from-violet-500 to-purple-600",
			"from-amber-500 to-orange-600",
			"from-emerald-500 to-green-600",
			"from-rose-500 to-pink-600",
			"from-blue-500 to-indigo-600",
		];
		const index = name
			.split("")
			.reduce((acc, char) => acc + char.charCodeAt(0), 0);
		return colors[index % colors.length];
	};

	return (
		<div
			className={`
        relative overflow-hidden rounded-2xl
        bg-gradient-to-br from-slate-800/90 to-slate-900/90
        border border-white/5
        transition-all duration-300 ease-out
        ${participant.isSpeaking ? "ring-2 ring-cyan-400/60 ring-offset-2 ring-offset-slate-950" : ""}
        ${isSpotlight ? "shadow-2xl shadow-black/50" : "shadow-lg shadow-black/30"}
        group
      `}
			style={{ aspectRatio: isSpotlight ? "auto" : "16/9" }}
		>
			{/* Subtle noise texture overlay */}
			<div
				className="absolute inset-0 opacity-[0.015] pointer-events-none"
				style={{
					backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`,
				}}
			/>

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
            w-20 h-20 rounded-full bg-gradient-to-br ${getAvatarColor(participant.displayName)}
            flex items-center justify-center text-2xl font-semibold text-white
            shadow-lg shadow-black/30
            transition-transform duration-300 group-hover:scale-105
          `}
					>
						{getInitials(participant.displayName)}
					</div>
				</div>
			)}

			{/* Bottom gradient overlay */}
			<div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-black/70 via-black/30 to-transparent pointer-events-none" />

			{/* Name and status bar */}
			<div className="absolute bottom-0 inset-x-0 p-3 flex items-center justify-between">
				<div className="flex items-center gap-2">
					<span className="text-sm font-medium text-white/90 drop-shadow-sm">
						{participant.displayName}
						{participant.isLocal && (
							<span className="ml-1.5 text-xs text-cyan-400/90">(You)</span>
						)}
					</span>
				</div>

				<div className="flex items-center gap-1.5">
					{!participant.audioEnabled && (
						<div className="w-6 h-6 rounded-full bg-red-500/80 flex items-center justify-center backdrop-blur-sm">
							<MicIcon muted />
						</div>
					)}
					{participant.isScreenSharing && (
						<div className="w-6 h-6 rounded-full bg-cyan-500/80 flex items-center justify-center backdrop-blur-sm">
							<ScreenShareIcon active />
						</div>
					)}
				</div>
			</div>

			{/* Speaking indicator glow */}
			{participant.isSpeaking && (
				<div
					className="absolute inset-0 rounded-2xl animate-pulse pointer-events-none"
					style={{ boxShadow: "inset 0 0 30px rgba(34, 211, 238, 0.15)" }}
				/>
			)}
		</div>
	);
}
