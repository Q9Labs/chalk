/**
 * VideoGrid - Video tile grid component
 *
 * Displays: participant video tiles in grid or spotlight layout
 * Handles: screen share priority, active speaker highlighting
 */

import { VideoTile } from "@q9labs/chalk-react";
import { Mic, MicOff, Monitor } from "lucide-react";
import { memo, useEffect } from "react";
import { createDebugger } from "@/features/room/utils/debug";

const log = createDebugger("VideoGrid");

interface Participant {
	id: string;
	displayName: string;
	videoTrack?: MediaStreamTrack | null;
	audioTrack?: MediaStreamTrack | null;
	screenShareTrack?: MediaStreamTrack | null;
	isLocal: boolean;
	isScreenSharing?: boolean;
	isSpeaking?: boolean;
	handRaised?: boolean;
	connectionQuality?: number;
	videoEnabled?: boolean;
	audioEnabled?: boolean;
}

interface VideoGridProps {
	participants: Participant[];
	localParticipant: Participant | null;
	activeSpeaker: { id: string } | null;
	layout: "grid" | "spotlight";
	isHandRaised: boolean;
}

export const VideoGrid = memo(function VideoGrid({
	participants,
	localParticipant,
	activeSpeaker,
	layout,
	isHandRaised,
}: VideoGridProps) {
	// ==========================================================================
	// LIFECYCLE & DEBUG
	// ==========================================================================

	useEffect(() => {
		log.lifecycle("mount");
		log.debug("Initial Props", {
			participantCount: participants.length,
			localParticipantId: localParticipant?.id,
			activeSpeakerId: activeSpeaker?.id,
			layout,
		});

		return () => log.lifecycle("unmount");
	}, []);

	// Only log render on layout or participant count changes
	useEffect(() => {
		log.debug("VideoGrid Render", { layout, participantCount: allParticipants.length });
	}, [layout, allParticipants.length]);

	useEffect(() => {
		log.debug("Participants Update", {
			count: allParticipants.length,
			participants: allParticipants.map(p => ({
				id: p.id.substring(0, 8),
				name: p.displayName,
				hasVideo: !!p.videoTrack,
				hasAudio: !!p.audioTrack,
				hasScreenShare: !!p.screenShareTrack,
				videoEnabled: p.videoEnabled,
				audioEnabled: p.audioEnabled,
				isScreenSharing: p.isScreenSharing,
				isSpeaking: p.isSpeaking,
				isLocal: p.isLocal,
			})),
		});
	}, [allParticipants]);

	useEffect(() => {
		if (activeSpeaker) {
			const speaker = participants.find(p => p.id === activeSpeaker.id);
			log.event("participant", `Active speaker: ${speaker?.displayName || "unknown"}`, `id=${activeSpeaker.id}`);
		}
	}, [activeSpeaker?.id, participants]);

	// ==========================================================================
	// COMPUTED VALUES
	// ==========================================================================

	// CRITICAL: Combine local + remote participants for display
	// The `participants` array from useParticipants only contains REMOTE participants
	// We need to include localParticipant to show local user's screen share
	const allParticipants = localParticipant
		? [localParticipant, ...participants.filter(p => p.id !== localParticipant.id)]
		: participants;

	const screenSharer = allParticipants.find(
		(p) => p.isScreenSharing && p.screenShareTrack
	);
	const showScreenShare = !!screenSharer;

	const visibleParticipants =
		layout === "grid" ? allParticipants : allParticipants.slice(0, 6);

	const mainParticipant =
		allParticipants.find((p) => p.id === activeSpeaker?.id) ||
		allParticipants[0] ||
		localParticipant;

	useEffect(() => {
		log.debug("Layout Calculation", {
			layout,
			showScreenShare,
			screenSharerName: screenSharer?.displayName,
			visibleCount: visibleParticipants.length,
			mainParticipantName: mainParticipant?.displayName,
		});
	}, [layout, showScreenShare, screenSharer, visibleParticipants.length, mainParticipant]);

	// ==========================================================================
	// HELPERS
	// ==========================================================================

	const mapToVideoTileParticipant = (p: Participant): TileParticipant => {
		const quality = p.connectionQuality;
		return {
			id: p.id,
			displayName: p.displayName,
			videoTrack: p.videoTrack,
			audioTrack: p.audioTrack,
			screenShareTrack: p.screenShareTrack,
			isLocal: p.isLocal,
			isScreenSharing: p.isScreenSharing,
			handRaised: p.handRaised,
			connectionQuality:
				quality && quality >= 1 && quality <= 4
					? (quality as 1 | 2 | 3 | 4)
					: undefined,
			isHandRaised: p.id === localParticipant?.id ? isHandRaised : p.handRaised,
			isSpeaking: p.id === activeSpeaker?.id || p.isSpeaking,
			// CRITICAL: Pass video/audio enabled state to VideoTile
			isVideoEnabled: p.videoEnabled ?? !!p.videoTrack,
			isMuted: !(p.audioEnabled ?? !!p.audioTrack),
		};
	};

	const getGridCols = () => {
		if (layout === "spotlight") return "grid-cols-1";
		if (allParticipants.length <= 1) return "grid-cols-1";
		if (allParticipants.length <= 2) return "grid-cols-2";
		return "grid-cols-3";
	};

	// ==========================================================================
	// RENDER
	// ==========================================================================

	return (
		<div
			className="flex-1 flex flex-col min-w-0 transition-all duration-500 ease-in-out"
			data-tour="video-grid"
		>
			{showScreenShare && screenSharer ? (
				// Screen Share View with participant thumbnails
				<div className="w-full h-full flex gap-4">
					{/* Main screen share area */}
					<div className="flex-1 min-w-0">
						<ScreenShareTile
							participant={mapToVideoTileParticipant(screenSharer)}
							screenShareTrack={screenSharer.screenShareTrack!}
						/>
					</div>
					{/* Participant thumbnails sidebar */}
					<div className="w-48 flex flex-col gap-2 overflow-y-auto">
						{allParticipants.map((p) => (
							<ThumbnailTile
								key={p.id}
								participant={mapToVideoTileParticipant(p)}
								isLocalParticipant={p.id === localParticipant?.id}
								isScreenSharer={p.id === screenSharer.id}
							/>
						))}
					</div>
				</div>
			) : (
				<div
					className={`w-full h-full grid gap-4 transition-all duration-500 ${getGridCols()}`}
				>
					{layout === "spotlight" && mainParticipant ? (
						// Spotlight View
						<SpotlightTile
							participant={mapToVideoTileParticipant(mainParticipant)}
						/>
					) : (
						// Grid View
						visibleParticipants.map((p) => (
							<GridTile
								key={p.id}
								participant={mapToVideoTileParticipant(p)}
								isLocalParticipant={p.id === localParticipant?.id}
							/>
						))
					)}
				</div>
			)}
		</div>
	);
});

// ==========================================================================
// SUB-COMPONENTS
// ==========================================================================

interface TileParticipant {
	id: string;
	displayName: string;
	videoTrack?: MediaStreamTrack | null;
	audioTrack?: MediaStreamTrack | null;
	screenShareTrack?: MediaStreamTrack | null;
	isLocal: boolean;
	isScreenSharing?: boolean;
	isSpeaking?: boolean;
	handRaised?: boolean;
	connectionQuality?: 1 | 2 | 3 | 4;
	isHandRaised?: boolean;
	isVideoEnabled?: boolean;
	isMuted?: boolean;
}

function ScreenShareTile({
	participant,
	screenShareTrack,
}: {
	participant: TileParticipant;
	screenShareTrack: MediaStreamTrack;
}) {
	useEffect(() => {
		log.info("screen", `Screen share active: ${participant.displayName}`, "media");
	}, [participant.displayName]);

	return (
		<div className="relative w-full h-full rounded-[32px] overflow-hidden border border-emerald-500/30 bg-gradient-to-b from-emerald-950/40 to-background shadow-2xl">
			<VideoTile
				participant={participant}
				videoTrack={screenShareTrack}
				mirror={false}
				aspectRatio="16:9"
				className="w-full h-full bg-transparent"
				showStatus={false}
				showName={false}
			/>
			<div className="absolute bottom-8 left-8 px-5 py-3 bg-emerald-500/15 backdrop-blur-2xl rounded-2xl border border-emerald-500/25 shadow-[0_4px_30px_rgba(0,0,0,0.1)] flex items-center gap-2">
				<Monitor size={18} className="text-emerald-400" />
				<h3 className="text-foreground font-bold text-xl tracking-wide">
					{participant.displayName}'s screen
				</h3>
			</div>
		</div>
	);
}

function SpotlightTile({ participant }: { participant: TileParticipant }) {
	useEffect(() => {
		log.info("participant", `Spotlight: ${participant.displayName}`, "state");
	}, [participant.displayName]);

	return (
		<div className="relative w-full h-full rounded-[32px] overflow-hidden border border-border bg-gradient-to-b from-card to-background shadow-2xl">
			<VideoTile
				participant={participant}
				videoTrack={participant.videoTrack}
				mirror={participant.isLocal}
				className="w-full h-full bg-transparent"
				showStatus={false}
				showName={false}
			/>
			<div className="absolute bottom-8 left-8 px-5 py-3 bg-background/70 backdrop-blur-2xl rounded-2xl border border-border shadow-[0_4px_30px_rgba(0,0,0,0.1)]">
				<h3 className="text-foreground font-bold text-xl tracking-wide">
					{participant.displayName}
				</h3>
			</div>
		</div>
	);
}

function GridTile({
	participant,
	isLocalParticipant,
}: {
	participant: TileParticipant;
	isLocalParticipant: boolean;
}) {
	const isSpeaking = participant.isSpeaking;
	const isMuted = participant.isMuted;

	return (
		<div className={`relative w-full h-full rounded-[32px] overflow-hidden border-2 ${isSpeaking ? "border-emerald-500 shadow-[0_0_20px_rgba(16,185,129,0.3)]" : "border-border"} bg-gradient-to-b from-card to-background shadow-xl group transition-all duration-300`}>
			<VideoTile
				participant={participant}
				videoTrack={participant.videoTrack}
				mirror={participant.isLocal}
				className="w-full h-full bg-transparent"
				showStatus={false}
				showName={false}
			/>
			<div className="absolute bottom-6 left-6 transition-transform duration-300 group-hover:scale-105">
				<div className="px-3 py-1.5 bg-background/70 backdrop-blur-2xl rounded-lg border border-border flex items-center gap-2 shadow-[0_4px_30px_rgba(0,0,0,0.1)]">
					{isMuted ? (
						<MicOff size={12} className="text-red-500" />
					) : (
						<Mic size={12} className={isSpeaking ? "text-emerald-500" : "text-foreground/60"} />
					)}
					<span className="text-foreground font-medium text-sm">
						{participant.displayName}
						{isLocalParticipant && " (You)"}
					</span>
				</div>
			</div>
		</div>
	);
}

function ThumbnailTile({
	participant,
	isLocalParticipant,
	isScreenSharer,
}: {
	participant: TileParticipant;
	isLocalParticipant: boolean;
	isScreenSharer: boolean;
}) {
	const isSpeaking = participant.isSpeaking;
	const isMuted = participant.isMuted;

	return (
		<div className={`relative w-full aspect-video rounded-xl overflow-hidden border ${isSpeaking ? "border-emerald-500" : isScreenSharer ? "border-emerald-500/50" : "border-border"} bg-gradient-to-b from-card to-background shadow-md transition-all duration-300`}>
			<VideoTile
				participant={participant}
				videoTrack={participant.videoTrack}
				mirror={participant.isLocal}
				className="w-full h-full bg-transparent"
				showStatus={false}
				showName={false}
			/>
			<div className="absolute bottom-1 left-1 right-1">
				<div className="px-2 py-1 bg-background/80 backdrop-blur rounded-md border border-border flex items-center gap-1 text-xs">
					{isMuted ? (
						<MicOff size={10} className="text-red-500" />
					) : (
						<Mic size={10} className={isSpeaking ? "text-emerald-500" : "text-foreground/60"} />
					)}
					<span className="text-foreground font-medium truncate">
						{participant.displayName}
						{isLocalParticipant && " (You)"}
					</span>
				</div>
			</div>
		</div>
	);
}
