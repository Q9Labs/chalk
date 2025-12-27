import {
	useDevices,
	useMedia,
	useParticipants,
	useRecording,
	useRoom,
} from "@chalk/react";
import { useState } from "react";
import { ControlBar } from "./ControlBar";
import { UsersIcon } from "./icons";
import { type ParticipantData, ParticipantTile } from "./ParticipantTile";
import { SettingsPanel } from "./SettingsPanel";

export interface ConferenceRoomProps {
	onLeave: () => void;
	roomId: string;
}

export function ConferenceRoom({ onLeave, roomId }: ConferenceRoomProps) {
	const { status } = useRoom();
	const { participants, localParticipant, activeSpeaker, participantCount } =
		useParticipants();
	const {
		isVideoEnabled,
		isAudioEnabled,
		isScreenSharing,
		toggleAudio,
		toggleVideo,
		startScreenShare,
		stopScreenShare,
	} = useMedia();
	const {
		cameras,
		microphones,
		selectedCamera,
		selectedMicrophone,
		selectCamera,
		selectMicrophone,
	} = useDevices();
	const { isRecording, startRecording, stopRecording, durationSeconds } =
		useRecording();

	const [showSettings, setShowSettings] = useState(false);

	const allParticipants: ParticipantData[] = localParticipant
		? [localParticipant, ...participants.filter((p) => !p.isLocal)]
		: participants;

	const formatTime = (seconds: number) => {
		const mins = Math.floor(seconds / 60);
		const secs = seconds % 60;
		return `${mins}:${secs.toString().padStart(2, "0")}`;
	};

	return (
		<div className="flex flex-col h-screen bg-slate-950 text-slate-100 overflow-hidden">
			{/* Ambient background gradient */}
			<div className="fixed inset-0 pointer-events-none">
				<div className="absolute top-0 left-1/4 w-96 h-96 bg-cyan-500/5 rounded-full blur-3xl" />
				<div className="absolute bottom-0 right-1/4 w-96 h-96 bg-violet-500/5 rounded-full blur-3xl" />
			</div>

			{/* Top Bar */}
			<header className="relative z-20 flex items-center justify-between px-5 py-3 bg-slate-900/60 backdrop-blur-xl border-b border-white/5">
				<div className="flex items-center gap-4">
					{/* Room info */}
					<div className="flex items-center gap-3">
						<div className="flex items-center gap-2">
							<div
								className={`w-2 h-2 rounded-full ${status === "connected" ? "bg-emerald-400 shadow-sm shadow-emerald-400/50" : "bg-amber-400 animate-pulse"}`}
							/>
							<span className="text-sm font-medium text-slate-300">
								{roomId}
							</span>
						</div>
					</div>

					<div className="h-4 w-px bg-slate-700" />

					{/* Participant count */}
					<div className="flex items-center gap-2 text-sm text-slate-400">
						<UsersIcon />
						<span>
							{participantCount}{" "}
							{participantCount === 1 ? "participant" : "participants"}
						</span>
					</div>

					{/* Recording indicator */}
					{isRecording && (
						<>
							<div className="h-4 w-px bg-slate-700" />
							<div className="flex items-center gap-2 px-2.5 py-1 rounded-full bg-red-500/10 border border-red-500/20">
								<div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
								<span className="text-xs font-medium text-red-400">
									REC {formatTime(durationSeconds)}
								</span>
							</div>
						</>
					)}
				</div>

				{/* Settings button and panel */}
				<SettingsPanel
					isOpen={showSettings}
					onClose={() => setShowSettings(false)}
					onToggle={() => setShowSettings(!showSettings)}
					isVideoEnabled={isVideoEnabled}
					isAudioEnabled={isAudioEnabled}
					isScreenSharing={isScreenSharing}
					cameras={cameras}
					microphones={microphones}
					selectedCamera={selectedCamera}
					selectedMicrophone={selectedMicrophone}
					onSelectCamera={selectCamera}
					onSelectMicrophone={selectMicrophone}
				/>
			</header>

			{/* Main Content */}
			<div className="flex-1 relative flex overflow-hidden">
				{/* Video Grid Area */}
				<main className="flex-1 flex flex-col p-4 overflow-hidden">
					<div className="flex-1 relative">
						{/* Participant Grid */}
						{allParticipants.length > 0 ? (
							<div
								className={`
                h-full w-full grid gap-3
                ${allParticipants.length === 1 ? "grid-cols-1" : ""}
                ${allParticipants.length === 2 ? "grid-cols-2" : ""}
                ${allParticipants.length >= 3 && allParticipants.length <= 4 ? "grid-cols-2 grid-rows-2" : ""}
                ${allParticipants.length >= 5 && allParticipants.length <= 6 ? "grid-cols-3 grid-rows-2" : ""}
                ${allParticipants.length > 6 ? "grid-cols-4" : ""}
              `}
							>
								{allParticipants.map((participant) => (
									<ParticipantTile
										key={participant.id}
										participant={participant}
										isSpotlight={
											allParticipants.length === 1 ||
											participant.id === activeSpeaker?.id
										}
									/>
								))}
							</div>
						) : (
							<div className="h-full flex flex-col items-center justify-center gap-4 text-slate-500">
								<div className="w-20 h-20 rounded-full bg-slate-800/50 flex items-center justify-center border border-slate-700/50">
									<UsersIcon />
								</div>
								<p className="text-sm">Waiting for others to join...</p>
							</div>
						)}

						{/* Floating Control Bar */}
						<ControlBar
							isAudioEnabled={isAudioEnabled}
							isVideoEnabled={isVideoEnabled}
							isScreenSharing={isScreenSharing}
							isRecording={isRecording}
							onToggleAudio={toggleAudio}
							onToggleVideo={toggleVideo}
							onToggleScreenShare={() =>
								isScreenSharing ? stopScreenShare() : startScreenShare()
							}
							onToggleRecording={() =>
								isRecording ? stopRecording() : startRecording()
							}
							onLeave={onLeave}
						/>
					</div>
				</main>
			</div>
		</div>
	);
}
