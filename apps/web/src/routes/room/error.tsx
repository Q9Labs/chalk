import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";

const errorSearchSchema = z.object({
	message: z.string().optional(),
	roomId: z.string().optional(),
});

export const Route = createFileRoute("/room/error")({
	validateSearch: errorSearchSchema,
	component: RoomErrorPage,
});

function RoomErrorPage() {
	const navigate = useNavigate();
	const { message, roomId } = Route.useSearch();

	const errorMessage =
		message || "An unknown error occurred while connecting to the room.";

	const handleRetry = () => {
		if (roomId) {
			// Go back to lobby for this room
			navigate({ to: "/room/lobby", search: { roomId } });
		} else {
			// Go to demo page to select a room
			navigate({ to: "/demo" });
		}
	};

	const handleGoBack = () => {
		navigate({ to: "/demo" });
	};

	return (
		<div className="flex items-center justify-center min-h-screen bg-[#1c1c1c] text-white">
			<div className="text-center max-w-lg p-6 bg-white/5 backdrop-blur-lg rounded-2xl border border-white/10 shadow-2xl">
				<div className="text-red-500 text-4xl mb-4">Connection Error</div>
				<p className="text-red-200 mb-6">{errorMessage}</p>
				<div className="space-x-4">
					<button
						type="button"
						onClick={handleRetry}
						className="px-6 py-2 bg-primary text-white rounded-full hover:bg-primary/80 transition-all"
					>
						Retry
					</button>
					<button
						type="button"
						onClick={handleGoBack}
						className="px-6 py-2 bg-white/10 text-white rounded-full hover:bg-white/20 transition-all"
					>
						Back to Lobby
					</button>
				</div>
			</div>
		</div>
	);
}

export default RoomErrorPage;
