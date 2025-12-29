import {
	useDevices,
	useMedia,
	useParticipants,
	useRecording,
} from "@q9labs/chalk-react";
import { useState } from "react";
import { ControlBar } from "./ControlBar";
import { UsersIcon } from "./icons";
import { type ParticipantData, ParticipantTile } from "./ParticipantTile";
import { SettingsPanel } from "./SettingsPanel";
import { SidePanel } from "./SidePanel";
import { ReactionsOverlay } from "./ReactionsOverlay";

import { Whiteboard } from "./Whiteboard";
import { useSoundEffects } from "../../hooks/useSoundEffects";

export interface ConferenceRoomProps {
	onLeave: () => void;
	roomId: string;
}

export function ConferenceRoom({ onLeave, roomId }: ConferenceRoomProps) {
	useSoundEffects();
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
	const [activeTab, setActiveTab] = useState<'chat' | 'participants' | null>(null);
	const [showWhiteboard, setShowWhiteboard] = useState(false);

	const allParticipants: ParticipantData[] = localParticipant
		? [localParticipant, ...participants.filter((p) => !p.isLocal)]
		: participants;

	const screenSharer = allParticipants.find((p) => p.isScreenSharing);

	const handleTabChange = (tab: 'chat' | 'participants') => {
		if (activeTab === tab) {
			setActiveTab(null);
		} else {
			setActiveTab(tab);
		}
	};

	return (
		<div className="flex flex-col h-screen bg-[#202124] text-white overflow-hidden">
			<div className="flex-1 min-h-0 flex relative">
				<div className="flex-1 p-4 flex items-center justify-center transition-all duration-300 relative">
					{showWhiteboard ? (
						<div className="w-full h-full relative">
							<Whiteboard 
								isOpen={showWhiteboard} 
								onClose={() => setShowWhiteboard(false)} 
							/>
						</div>
					) : screenSharer ? (
						<div className="w-full h-full flex flex-col gap-4">
							<div className="flex-1 min-h-0 relative rounded-2xl overflow-hidden bg-black/50 ring-1 ring-white/10">
								<ParticipantTile
									participant={screenSharer}
									isSpotlight={true}
								/>
								<div className="absolute top-4 left-4 bg-blue-600/90 text-white px-3 py-1 rounded-full text-sm font-medium backdrop-blur-md">
									{screenSharer.displayName} is presenting
								</div>
							</div>
							
							<div className="h-32 flex gap-4 overflow-x-auto pb-2 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-white/10">
								{allParticipants.filter(p => p.id !== screenSharer.id).map((participant) => (
									<div key={participant.id} className="h-full aspect-video flex-shrink-0">
										<ParticipantTile
											participant={participant}
										/>
									</div>
								))}
							</div>
						</div>
					) : allParticipants.length > 0 ? (
						<div
							className={`
								w-full max-w-[1600px] h-full
								grid gap-4 auto-rows-fr
								transition-all duration-300
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
					
					<ReactionsOverlay />
				</div>

				<SidePanel 
					isOpen={activeTab !== null}
					onClose={() => setActiveTab(null)}
					activeTab={activeTab || 'chat'}
					onTabChange={(tab) => setActiveTab(tab)}
				/>
			</div>

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
				onToggleChat={() => handleTabChange('chat')}
				onToggleParticipants={() => handleTabChange('participants')}
				isChatOpen={activeTab === 'chat'}
				isParticipantsOpen={activeTab === 'participants'}
				participantCount={allParticipants.length}
				onToggleWhiteboard={() => setShowWhiteboard(!showWhiteboard)}
				isWhiteboardOpen={showWhiteboard}
			/>

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
