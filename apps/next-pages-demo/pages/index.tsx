import { Inter } from "next/font/google";
import { useRouter } from "next/router";
import { useState } from "react";

const inter = Inter({ subsets: ["latin"] });

export default function Home() {
	const router = useRouter();
	const [roomId, setRoomId] = useState("");

	const handleJoinRoom = (e: React.FormEvent) => {
		e.preventDefault();
		if (roomId.trim()) {
			router.push(`/room/${roomId.trim()}`);
		}
	};

	return (
		<main
			className={`flex min-h-screen flex-col items-center justify-center p-24 ${inter.className}`}
		>
			<div className="w-full max-w-md space-y-8">
				<div className="text-center">
					<h1 className="text-4xl font-bold mb-2">Chalk SDK Demo</h1>
					<p className="text-gray-500 dark:text-gray-400">
						Next.js Pages Router Integration Test
					</p>
				</div>

				<form onSubmit={handleJoinRoom} className="space-y-4">
					<div>
						<label
							htmlFor="roomId"
							className="block text-sm font-medium mb-2"
						>
							Room ID
						</label>
						<input
							id="roomId"
							type="text"
							value={roomId}
							onChange={(e) => setRoomId(e.target.value)}
							placeholder="Enter room ID or create new"
							className="w-full px-4 py-3 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
						/>
					</div>

					<button
						type="submit"
						disabled={!roomId.trim()}
						className="w-full py-3 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors"
					>
						Join Room
					</button>
				</form>

				<div className="text-center text-sm text-gray-500">
					<p>Or try a quick demo room:</p>
					<button
						onClick={() => router.push("/room/demo-room-" + Date.now())}
						className="mt-2 text-blue-600 hover:underline"
					>
						Create instant room
					</button>
				</div>
			</div>
		</main>
	);
}
