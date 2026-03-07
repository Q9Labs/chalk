import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";

export const Route = createFileRoute("/demo")({
	component: DemoPage,
});

function DemoPage() {
	useEffect(() => {
		const randomId = Math.floor(Math.random() * 10000)
			.toString()
			.padStart(4, "0");
		window.location.assign(`/room/room-${randomId}`);
	}, []);

	return (
		<div className="flex items-center justify-center min-h-screen bg-[#0D0D0D] text-white">
			<div className="animate-pulse">Redirecting to demo room...</div>
		</div>
	);
}
