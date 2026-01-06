/**
 * VideoGrid - Video tile grid component
 *
 * Displays: participant video tiles in grid or spotlight layout
 * Handles: screen share priority, active speaker highlighting
 */

import { VideoTile } from "@q9labs/chalk-react";
import { Mic, Monitor } from "lucide-react";
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
		log.debug("VideoGrid Render", { layout, participantCount: participants.length });
	}, [layout, participants.length]);

	useEffect(() => {
		log.debug("Participants Update", {
			count: participants.length,
			participants: participants.map(p => ({
				id: p.id.substring(0, 8),
				name: p.displayName,
				hasVideo: !!p.videoTrack,
				hasAudio: !!p.audioTrack,
				isScreenSharing: p.isScreenSharing,
				isSpeaking: p.isSpeaking,
				isLocal: p.isLocal,
			})),
		});
	}, [participants]);

	useEffect(() => {
		if (activeSpeaker) {
			const speaker = participants.find(p => p.id === activeSpeaker.id);
			log.event("participant", `Active speaker: ${speaker?.displayName || "unknown"}`, `id=${activeSpeaker.id}`);
		}
	}, [activeSpeaker?.id, participants]);

	// ==========================================================================
	// COMPUTED VALUES
	// ==========================================================================

	const screenSharer = participants.find(
		(p) => p.isScreenSharing && p.screenShareTrack
	);
	const showScreenShare = !!screenSharer;

	const visibleParticipants =
		layout === "grid" ? participants : participants.slice(0, 6);

	const mainParticipant =
		participants.find((p) => p.id === activeSpeaker?.id) ||
		participants[0] ||
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
		};
	};

	const getGridCols = () => {
		if (layout === "spotlight") return "grid-cols-1";
		if (participants.length <= 1) return "grid-cols-1";
		if (participants.length <= 2) return "grid-cols-2";
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
			<div
				className={`w-full h-full grid gap-4 transition-all duration-500 ${getGridCols()}`}
			>
				{showScreenShare && screenSharer ? (
					// Screen Share View (takes priority)
					<ScreenShareTile
						participant={mapToVideoTileParticipant(screenSharer)}
						screenShareTrack={screenSharer.screenShareTrack!}
					/>
				) : layout === "spotlight" && mainParticipant ? (
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
		<div className="relative w-full h-full rounded-[32px] overflow-hidden border border-green-500/50 bg-gradient-to-b from-[#0a2e0a] to-[#0a0a0a] shadow-2xl">
			<VideoTile
				participant={participant}
				videoTrack={screenShareTrack}
				mirror={false}
				aspectRatio="16:9"
				className="w-full h-full bg-transparent"
				showStatus={false}
				showName={false}
			/>
			<div className="absolute bottom-8 left-8 px-5 py-3 bg-green-500/20 backdrop-blur-2xl rounded-2xl border border-green-500/30 shadow-[0_4px_30px_rgba(0,0,0,0.1)] flex items-center gap-2">
				<Monitor size={18} className="text-green-400" />
				<h3 className="text-white font-bold text-xl tracking-wide">
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
		<div className="relative w-full h-full rounded-[32px] overflow-hidden border border-white/80 bg-gradient-to-b from-[#2e0046] to-[#0a0a0a] shadow-2xl">
			<VideoTile
				participant={participant}
				videoTrack={participant.videoTrack}
				mirror={participant.isLocal}
				className="w-full h-full bg-transparent"
				showStatus={false}
				showName={false}
			/>
			<div className="absolute bottom-8 left-8 px-5 py-3 bg-white/5 backdrop-blur-2xl rounded-2xl border border-white/10 shadow-[0_4px_30px_rgba(0,0,0,0.1)]">
				<h3 className="text-white font-bold text-xl tracking-wide">
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
	return (
		<div className="relative w-full h-full rounded-[32px] overflow-hidden border border-white/10 bg-gradient-to-b from-[#2e0046] to-[#0a0a0a] shadow-xl group">
			<VideoTile
				participant={participant}
				videoTrack={participant.videoTrack}
				mirror={participant.isLocal}
				className="w-full h-full bg-transparent"
				showStatus={false}
				showName={false}
			/>
			<div className="absolute bottom-6 left-6 transition-transform duration-300 group-hover:scale-105">
				<div className="px-4 py-2 bg-white/5 backdrop-blur-2xl rounded-xl border border-white/10 flex items-center gap-2 shadow-[0_4px_30px_rgba(0,0,0,0.1)]">
					{participant.isSpeaking && (
						<Mic size={14} className="text-green-400" />
					)}
					<h3 className="text-white font-bold text-lg tracking-wide">
						{participant.displayName}{" "}
						{isLocalParticipant && "(You)"}
					</h3>
				</div>
			</div>
		</div>
	);
}
