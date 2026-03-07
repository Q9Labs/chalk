import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import z from "zod";
import { exchangeJoinToken, getApiUrl, getRoomWithAccessToken, setJoinContext } from "../../lib/internalAuth";

export const Route = createFileRoute("/j/$joinToken")({
	component: JoinLinkPage,
	params: z.object({
		joinToken: z.string(),
	}),
});

function JoinLinkPage() {
	const { joinToken } = Route.useParams();
	const [error, setError] = useState<string | null>(null);
	const [waitingUntilMs, setWaitingUntilMs] = useState<number | null>(null);
	const [scheduledStartAt, setScheduledStartAt] = useState<string | null>(null);
	const [roomName, setRoomName] = useState<string | null>(null);
	const [nowMs, setNowMs] = useState<number>(Date.now());

	useEffect(() => {
		if (waitingUntilMs === null) {
			return;
		}
		const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [waitingUntilMs]);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const apiUrl = getApiUrl();
				const ex = await exchangeJoinToken(apiUrl, joinToken);
				if (cancelled) return;

				setRoomName(ex.room_name);
				setJoinContext({
					joinToken,
					roomName: ex.room_name,
					accessToken: ex.access_token,
					expiresAtMs: Date.now() + ex.expires_in * 1000,
				});

				try {
					const room = await getRoomWithAccessToken(apiUrl, ex.access_token, ex.room_name);
					if (cancelled) return;
					if (room.status === "scheduled" && room.scheduledStartAt) {
						const scheduledStartMs = new Date(room.scheduledStartAt).getTime();
						const joinOpenMs =
							scheduledStartMs - Math.max(0, room.allowEarlyJoinMinutes ?? 0) * 60_000;
						if (Number.isFinite(joinOpenMs) && Date.now() < joinOpenMs) {
							setScheduledStartAt(room.scheduledStartAt);
							setWaitingUntilMs(joinOpenMs);
							return;
						}
					}
				} catch {
					// Fail open if room lookup is unavailable.
				}

				window.location.replace(`/room/${encodeURIComponent(ex.room_name)}`);
			} catch (e) {
				if (cancelled) return;
				setError(e instanceof Error ? e.message : String(e));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [joinToken]);

	useEffect(() => {
		if (!roomName || waitingUntilMs === null) {
			return;
		}
		if (nowMs >= waitingUntilMs) {
			window.location.replace(`/room/${encodeURIComponent(roomName)}`);
		}
	}, [nowMs, roomName, waitingUntilMs]);

	const countdown = useMemo(() => {
		if (waitingUntilMs === null) {
			return null;
		}
		const remainingMs = Math.max(0, waitingUntilMs - nowMs);
		const totalSeconds = Math.floor(remainingMs / 1000);
		const hours = Math.floor(totalSeconds / 3600);
		const minutes = Math.floor((totalSeconds % 3600) / 60);
		const seconds = totalSeconds % 60;
		if (hours > 0) {
			return `${hours}h ${minutes}m ${seconds}s`;
		}
		return `${minutes}m ${seconds}s`;
	}, [nowMs, waitingUntilMs]);

	if (waitingUntilMs !== null) {
		return (
			<div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
				<div className="w-full max-w-md space-y-3">
					<h1 className="text-xl font-semibold">Class not started yet</h1>
					<p className="text-sm text-muted-foreground">
						You can join when the meeting window opens.
					</p>
					<div className="rounded-lg bg-muted p-3 text-xs space-y-1">
						{scheduledStartAt && (
							<p>
								Starts:{" "}
								{new Date(scheduledStartAt).toLocaleString(undefined, {
									weekday: "short",
									month: "short",
									day: "numeric",
									hour: "2-digit",
									minute: "2-digit",
								})}
							</p>
						)}
						<p>Join opens in: {countdown ?? "calculating..."}</p>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
			<div className="w-full max-w-md space-y-3">
				<h1 className="text-xl font-semibold">Joining meeting</h1>
				<p className="text-sm text-muted-foreground">
					{error ? "Could not join." : "Preparing your session..."}
				</p>
				{error && (
					<pre className="rounded-lg bg-muted p-3 text-xs whitespace-pre-wrap">
						{error}
					</pre>
				)}
			</div>
		</div>
	);
}
