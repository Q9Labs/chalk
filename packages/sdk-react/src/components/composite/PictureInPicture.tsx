/**
 * PictureInPicture - Mini meeting view rendered into a Document PiP window
 *
 * Shows the active speaker (or first remote participant) with minimal controls.
 * Renders via createPortal into the PiP window's document.body.
 */

import React, { useMemo } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../utils/cn";
import {
	CallEnd01Icon,
	Microphone01Icon,
	MicrophoneOff01Icon,
	Video01Icon,
	VideoOffIcon,
} from "../../utils/icons";
import { VideoTile } from "../atomic";
import type { Participant } from "./VideoGrid";

export interface PictureInPictureProps {
	/** The PiP Window to render into */
	pipWindow: Window;
	/** All participants */
	participants: Participant[];
	/** Active speaker (shown prominently) */
	activeSpeaker?: Participant | null;
	/** Local participant */
	localParticipant?: Participant | null;
	/** Whether local mic is muted */
	isMuted?: boolean;
	/** Whether local video is enabled */
	isVideoEnabled?: boolean;
	/** Toggle mute callback */
	onToggleMute?: () => void;
	/** Toggle video callback */
	onToggleVideo?: () => void;
	/** Leave meeting callback */
	onLeave?: () => void;
	/** Close PiP callback */
	onClose?: () => void;
}

/**
 * Picks the participant to feature in PiP.
 * Priority: active speaker > first remote > local.
 */
function useFeaturedParticipant(
	participants: Participant[],
	activeSpeaker?: Participant | null,
	localParticipant?: Participant | null,
) {
	return useMemo(() => {
		// Active speaker who isn't local
		if (activeSpeaker && !activeSpeaker.isLocal) return activeSpeaker;
		// First remote participant
		const remote = participants.find((p) => !p.isLocal);
		if (remote) return remote;
		// Fallback to local
		return localParticipant ?? participants[0] ?? null;
	}, [participants, activeSpeaker, localParticipant]);
}

const PipContent = React.memo(
	({
		participants,
		activeSpeaker,
		localParticipant,
		isMuted = false,
		isVideoEnabled = true,
		onToggleMute,
		onToggleVideo,
		onLeave,
		onClose,
	}: Omit<PictureInPictureProps, "pipWindow">) => {
		const featured = useFeaturedParticipant(
			participants,
			activeSpeaker,
			localParticipant,
		);

		if (!featured) return null;

		return (
			<div className="relative w-full h-full flex flex-col bg-black">
				{/* Featured participant video */}
				<div className="flex-1 min-h-0 relative">
					<VideoTile
						participant={{
							id: featured.id,
							displayName: featured.displayName,
							isLocal: featured.isLocal,
							isSpeaking: featured.isSpeaking,
							isMuted: featured.isMuted,
							isVideoEnabled: featured.isVideoEnabled,
							isScreenSharing: featured.isScreenSharing,
							avatarUrl: featured.avatarUrl,
						}}
						videoTrack={featured.videoTrack}
						mirror={featured.isLocal}
						aspectRatio="fill"
						className="w-full h-full rounded-none"
						showName
						showStatus={false}
					/>

					{/* Participant count badge */}
					{participants.length > 1 && (
						<div className="absolute top-2 left-2 px-2 py-0.5 rounded-full bg-black/60 backdrop-blur-sm">
							<span className="text-[10px] font-medium text-white">
								{participants.length} in call
							</span>
						</div>
					)}

					{/* Local self-view (small thumbnail) */}
					{localParticipant && !featured.isLocal && (
						<div className="absolute top-2 right-2 w-20 h-14 rounded-lg overflow-hidden shadow-lg border border-white/10">
							<VideoTile
								participant={{
									id: localParticipant.id,
									displayName: localParticipant.displayName,
									isLocal: true,
									isMuted: localParticipant.isMuted,
									isVideoEnabled: localParticipant.isVideoEnabled,
								}}
								videoTrack={localParticipant.videoTrack}
								mirror
								aspectRatio="fill"
								className="w-full h-full rounded-none"
								showName={false}
								showStatus={false}
							/>
						</div>
					)}
				</div>

				{/* Mini control bar */}
				<div className="shrink-0 flex items-center justify-center gap-2 px-3 py-2 bg-zinc-900/90 backdrop-blur-sm">
					{onToggleMute && (
						<button
							type="button"
							onClick={onToggleMute}
							className={cn(
								"flex items-center justify-center w-8 h-8 rounded-full transition-colors",
								isMuted
									? "bg-red-500/80 text-white hover:bg-red-500"
									: "bg-white/10 text-white hover:bg-white/20",
							)}
							aria-label={isMuted ? "Unmute" : "Mute"}
						>
							{isMuted ? (
								<MicrophoneOff01Icon size={14} />
							) : (
								<Microphone01Icon size={14} />
							)}
						</button>
					)}

					{onToggleVideo && (
						<button
							type="button"
							onClick={onToggleVideo}
							className={cn(
								"flex items-center justify-center w-8 h-8 rounded-full transition-colors",
								!isVideoEnabled
									? "bg-red-500/80 text-white hover:bg-red-500"
									: "bg-white/10 text-white hover:bg-white/20",
							)}
							aria-label={isVideoEnabled ? "Stop Video" : "Start Video"}
						>
							{isVideoEnabled ? (
								<Video01Icon size={14} />
							) : (
								<VideoOffIcon size={14} />
							)}
						</button>
					)}

					{onLeave && (
						<button
							type="button"
							onClick={onLeave}
							className="flex items-center justify-center w-8 h-8 rounded-full bg-red-600 text-white hover:bg-red-700 transition-colors"
							aria-label="Leave call"
						>
							<CallEnd01Icon size={14} />
						</button>
					)}

					{onClose && (
						<button
							type="button"
							onClick={onClose}
							className="flex items-center justify-center w-8 h-8 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors text-xs font-medium"
							aria-label="Back to tab"
						>
							↩
						</button>
					)}
				</div>
			</div>
		);
	},
);

PipContent.displayName = "PipContent";

export const PictureInPicture = React.memo(
	({ pipWindow, ...contentProps }: PictureInPictureProps) => {
		return createPortal(
			<PipContent {...contentProps} />,
			pipWindow.document.body,
		);
	},
);

PictureInPicture.displayName = "PictureInPicture";
