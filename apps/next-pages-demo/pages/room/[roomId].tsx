import { VideoConference } from "@q9labs/chalk-react";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";

export default function RoomPage() {
	const router = useRouter();
	const { roomId } = router.query;
	const [theme, setTheme] = useState<"light" | "dark">("dark");

	// Apply theme to document
	useEffect(() => {
		document.documentElement.setAttribute("data-chalk-theme", theme);
		document.documentElement.classList.toggle("dark", theme === "dark");
	}, [theme]);

	if (!roomId || typeof roomId !== "string") {
		return (
			<div className="flex min-h-screen items-center justify-center bg-gray-900 text-white">
				<p>Loading room...</p>
			</div>
		);
	}

	return (
		<div className="relative min-h-screen" data-chalk-theme={theme}>
			{/* Theme toggle */}
			<button
				onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
				className="absolute top-4 right-4 z-50 p-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-white shadow-lg"
				title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
			>
				{theme === "dark" ? "☀️" : "🌙"}
			</button>

			<VideoConference
				debug={true}
				roomId={roomId}
				userName="Demo User"
				features={{
					chat: true,
					screenShare: true,
					reactions: true,
					handRaise: true,
					recording: true,
					whiteboard: true,
				}}
				
				onLeave={() => router.push("/")}
			/>
		</div>
	);
}
