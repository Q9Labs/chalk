import {
	useDevices,
	useMedia,
	useParticipants,
	useRecording,
	useRoom,
} from "@q9labs/chalk-react";
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
	const { participants, localParticipant, activeSpeaker } = useParticipants();
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
	const { isRecording, startRecording, stopRecording } = useRecording();

	const [showSettings, setShowSettings] = useState(false);

	const allParticipants: ParticipantData[] = localParticipant
		? [localParticipant, ...participants.filter((p) => !p.isLocal)]
		: participants;

	return (
		<div className="flex flex-col h-screen bg-[#202124] text-white overflow-hidden">
			{/* Main Content - Video Grid */}
			<div className="flex-1 min-h-0 relative p-4 flex items-center justify-center">
				{allParticipants.length > 0 ? (
					<div
						className={`
							w-full max-w-[1600px] h-full
							grid gap-4 auto-rows-fr
							${allParticipants.length === 1 ? "grid-cols-1 max-w-4xl max-h-[600px]" : ""}
							${allParticipants.length === 2 ? "grid-cols-2 max-h-[500px]" : ""}
							${allParticipants.length >= 3 && allParticipants.length <= 4 ? "grid-cols-2 max-h-[800px]" : ""}
							${allParticipants.length >= 5 && allParticipants.length <= 6 ? "grid-cols-3" : ""}
							${allParticipants.length >= 7 && allParticipants.length <= 9 ? "grid-cols-3" : ""}
							${allParticipants.length > 9 ? "grid-cols-4" : ""}
							items-center justify-center content-center
						`}
					>
						{allParticipants.map((participant) => (
							<ParticipantTile
								key={participant.id}
								participant={participant}
								isSpotlight={
									allParticipants.length === 1 || participant.id === activeSpeaker?.id
								}
							/>
						))}
					</div>
				) : (
					<div className="h-full flex flex-col items-center justify-center gap-6 text-zinc-400">
						<div className="w-24 h-24 rounded-full bg-[#3c4043] flex items-center justify-center">
							<UsersIcon />
						</div>
						<div className="text-center space-y-2">
							<h3 className="text-xl font-medium text-white">
								You are the only one here
							</h3>
							<p className="text-sm">Share the room ID to invite others</p>
						</div>
					</div>
				)}
			</div>

			{/* Bottom Control Bar */}
			<ControlBar
				roomId={roomId}
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
				onToggleSettings={() => setShowSettings(true)}
			/>

			{/* Settings Panel Modal */}
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
		</div>
	);
}
