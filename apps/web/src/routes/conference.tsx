import { ChalkProvider, useChalk } from "@q9labs/chalk-react";
import { createFileRoute, Link, useSearch } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ConferenceRoom } from "../components/conference/ConferenceRoom";
import { MediaConfig, PreJoinLobby } from "../components/conference/PreJoinLobby";

interface ConferenceSearchParams {
	room?: string;
}

export const Route = createFileRoute("/conference")({
	component: ConferencePage,
	validateSearch: (search: Record<string, unknown>) =>
		({
			room: (search.room as string) || "demo-room-001",
		}) as ConferenceSearchParams,
});

function ConferencePage() {
	return (
		<ChalkProvider debug>
			<div className="min-h-screen bg-background text-foreground font-sans">
				<ConferenceContent />
			</div>
		</ChalkProvider>
	);
}

function ConferenceContent() {
	const search = useSearch({ from: Route.id });
	const { room, isConnected, joinRoom, leaveRoom } = useChalk();
	const [initialRoomId, setInitialRoomId] = useState(search.room || "demo-room-001");
	const [isJoining, setIsJoining] = useState(false);

	useEffect(() => {
		if (!initialRoomId) {
			setInitialRoomId(`room-${Math.floor(Math.random() * 10000)}`);
		}
	}, [initialRoomId]);

	const handleJoin = useCallback(async (displayName: string, roomId: string, config: MediaConfig) => {
		setIsJoining(true);
		try {
			await joinRoom(roomId, {
				displayName: displayName.trim(),
				audio: config.audioEnabled,
				video: config.videoEnabled,
			});
		} catch (error) {
			console.error("Failed to join room:", error);
		} finally {
			setIsJoining(false);
		}
	}, [joinRoom]);

	const handleLeave = useCallback(() => {
		leaveRoom();
	}, [leaveRoom]);

	if (isConnected && room) {
		return <ConferenceRoom onLeave={handleLeave} roomId={room.id} />;
	}

	return (
		<div className="flex min-h-screen flex-col bg-muted/30">
			<header className="flex h-16 items-center border-b bg-background px-6 fixed top-0 w-full z-10">
				<Link
					to="/"
					className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
				>
					<ArrowLeft className="h-4 w-4" />
					Back to Home
				</Link>
			</header>

			<main className="flex-1 pt-16">
				<PreJoinLobby 
					roomId={initialRoomId} 
					onJoin={handleJoin} 
					isJoining={isJoining} 
				/>
			</main>
		</div>
	);
}

