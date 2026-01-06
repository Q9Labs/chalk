/**
 * LoadingScreen - Displayed while connecting to room
 */

import { useEffect } from "react";
import { createDebugger } from "@/features/room/utils/debug";

const log = createDebugger("LoadingScreen");

interface LoadingScreenProps {
	roomId: string;
}

export function LoadingScreen({ roomId }: LoadingScreenProps) {
	useEffect(() => {
		log.lifecycle("mount");
		log.info("loading", `Waiting to connect to room: ${roomId}`, "state");

		return () => {
			log.lifecycle("unmount");
			log.info("success", "Loading screen dismissed", "state");
		};
	}, [roomId]);

	return (
		<div className="flex items-center justify-center min-h-screen bg-[#1c1c1c] text-white">
			<div className="flex flex-col items-center p-8 rounded-3xl bg-black/40 backdrop-blur-xl border border-white/5">
				<div className="animate-spin h-8 w-8 border-4 border-purple-500 border-t-transparent rounded-full mb-4" />
				<p className="text-white/80 font-medium">Connecting to {roomId}...</p>
			</div>
		</div>
	);
}
