import type { ConferenceClient, RoomResource } from "@q9labs/chalk-core";
import { AlertCircleIcon, Calendar01Icon, Clock01Icon, Share01Icon, Video01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type ScheduledClassesPanelProps = {
	client: ConferenceClient;
	rooms: RoomResource[];
	isLoading: boolean;
	error: string | null;
	onRefresh: () => Promise<void>;
};

function toCountdown(targetMs: number, nowMs: number) {
	const remainingMs = Math.max(0, targetMs - nowMs);
	const totalSeconds = Math.floor(remainingMs / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	return `${minutes}m ${seconds}s`;
}

function toClassStartMs(room: RoomResource) {
	if (!room.scheduledStartAt) {
		return null;
	}
	const startMs = new Date(room.scheduledStartAt).getTime();
	return Number.isFinite(startMs) ? startMs : null;
}

function toJoinAllowedAtMs(room: RoomResource) {
	const startMs = toClassStartMs(room);
	if (startMs === null) {
		return null;
	}
	const earlyJoinMs = Math.max(0, room.allowEarlyJoinMinutes ?? 0) * 60_000;
	return startMs - earlyJoinMs;
}

export function ScheduledClassesPanel({ client, rooms, isLoading, error, onRefresh }: ScheduledClassesPanelProps) {
	const [className, setClassName] = useState("");
	const [startAtLocal, setStartAtLocal] = useState("");
	const [durationMinutes, setDurationMinutes] = useState("60");
	const [allowEarlyJoinMinutes, setAllowEarlyJoinMinutes] = useState("10");
	const [isCreating, setIsCreating] = useState(false);
	const [nowMs, setNowMs] = useState(Date.now());

	useEffect(() => {
		const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, []);

	const classRooms = useMemo(() => {
		return [...rooms]
			.filter((room) => room.status === "scheduled" || room.status === "active")
			.sort((a, b) => {
				const aMs = toClassStartMs(a) ?? new Date(a.createdAt).getTime();
				const bMs = toClassStartMs(b) ?? new Date(b.createdAt).getTime();
				return aMs - bMs;
			});
	}, [rooms]);

	async function createScheduledClass() {
		const trimmedName = className.trim();
		if (!trimmedName) {
			toast.error("Class title is required");
			return;
		}

		const startDate = new Date(startAtLocal);
		if (!Number.isFinite(startDate.getTime())) {
			toast.error("Pick a valid class start date/time");
			return;
		}
		if (startDate.getTime() <= Date.now()) {
			toast.error("Class start must be in the future");
			return;
		}

		const duration = Math.max(1, Number.parseInt(durationMinutes || "0", 10));
		const earlyJoin = Math.max(0, Number.parseInt(allowEarlyJoinMinutes || "0", 10));
		const scheduledEndAt = new Date(startDate.getTime() + duration * 60_000);

		setIsCreating(true);
		try {
			await client.scheduleRoom({
				name: trimmedName,
				scheduledStartAt: startDate.toISOString(),
				scheduledEndAt: scheduledEndAt.toISOString(),
				allowEarlyJoinMinutes: earlyJoin,
			});
			toast.success("Class scheduled");
			setClassName("");
			setStartAtLocal("");
			void onRefresh();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to schedule class");
		} finally {
			setIsCreating(false);
		}
	}

	async function copyInvite(roomId: string) {
		try {
			const response = await client.createJoinToken(roomId);
			const inviteUrl = `${window.location.origin}/j/${response.joinToken}`;
			await navigator.clipboard.writeText(inviteUrl);
			toast.success("Invite link copied");
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to create invite link");
		}
	}

	return (
		<section className="space-y-4">
			<div className="flex items-center justify-between">
				<h3 className="text-lg font-semibold">Scheduled Classes</h3>
				<button
					type="button"
					onClick={() => void onRefresh()}
					className="inline-flex items-center rounded-full border px-3 py-1.5 text-xs font-bold hover:bg-muted transition-colors"
				>
					Refresh
				</button>
			</div>

			<div className="rounded-2xl border bg-card p-4 space-y-3">
				<div className="grid grid-cols-1 md:grid-cols-4 gap-2">
					<input
						type="text"
						value={className}
						onChange={(e) => setClassName(e.target.value)}
						placeholder="Class title"
						className="h-10 rounded-xl border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-primary/20"
					/>
					<input
						type="datetime-local"
						value={startAtLocal}
						onChange={(e) => setStartAtLocal(e.target.value)}
						className="h-10 rounded-xl border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-primary/20"
					/>
					<input
						type="number"
						min={1}
						value={durationMinutes}
						onChange={(e) => setDurationMinutes(e.target.value)}
						placeholder="Duration (min)"
						className="h-10 rounded-xl border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-primary/20"
					/>
					<input
						type="number"
						min={0}
						value={allowEarlyJoinMinutes}
						onChange={(e) => setAllowEarlyJoinMinutes(e.target.value)}
						placeholder="Early join (min)"
						className="h-10 rounded-xl border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-primary/20"
					/>
				</div>
				<div className="flex justify-end">
					<button
						type="button"
						disabled={isCreating}
						onClick={() => void createScheduledClass()}
						className="inline-flex h-9 items-center justify-center rounded-full bg-primary px-4 text-xs font-bold text-primary-foreground hover:opacity-90 transition-all disabled:opacity-50"
					>
						{isCreating ? "Scheduling..." : "Schedule Class"}
					</button>
				</div>
			</div>

			{error && (
				<div className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive flex items-start gap-2">
					<HugeiconsIcon icon={AlertCircleIcon} size={16} className="shrink-0 mt-0.5" />
					<span>{error}</span>
				</div>
			)}

			{isLoading ? (
				<div className="rounded-2xl border bg-card p-6 text-sm text-muted-foreground">Loading classes...</div>
			) : classRooms.length === 0 ? (
				<div className="rounded-2xl border bg-card p-6 text-sm text-muted-foreground">
					No scheduled classes yet.
				</div>
			) : (
				<div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
					{classRooms.map((room) => {
						const startAtMs = toClassStartMs(room);
						const joinAllowedAtMs = toJoinAllowedAtMs(room);
						const isTooEarly =
							room.status === "scheduled" &&
							joinAllowedAtMs !== null &&
							nowMs < joinAllowedAtMs;
						const canEnter =
							room.status === "active" ||
							(room.status === "scheduled" && !isTooEarly);

						return (
							<div key={room.id} className="rounded-2xl border bg-card p-4 space-y-3">
								<div className="flex items-start justify-between gap-3">
									<div>
										<h4 className="font-semibold">{room.name || room.id}</h4>
										<div className="text-xs text-muted-foreground mt-1 flex items-center gap-3">
											{room.scheduledStartAt && (
												<span className="inline-flex items-center gap-1">
													<HugeiconsIcon icon={Calendar01Icon} size={14} />
													{new Date(room.scheduledStartAt).toLocaleString(undefined, {
														month: "short",
														day: "numeric",
														hour: "2-digit",
														minute: "2-digit",
													})}
												</span>
											)}
											<span className="inline-flex items-center gap-1">
												<HugeiconsIcon icon={Clock01Icon} size={14} />
												Early join: {room.allowEarlyJoinMinutes ?? 0}m
											</span>
										</div>
									</div>
									<div
										className={cn(
											"px-2 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider border",
											room.status === "active"
												? "bg-primary/10 border-primary/20 text-primary"
												: isTooEarly
													? "bg-orange-500/10 border-orange-500/20 text-orange-600"
													: "bg-green-500/10 border-green-500/20 text-green-600",
										)}
									>
										{room.status === "active"
											? "Live now"
											: isTooEarly && joinAllowedAtMs
												? `Opens in ${toCountdown(joinAllowedAtMs, nowMs)}`
												: "Join window open"}
									</div>
								</div>

								<div className="flex items-center justify-between gap-2 pt-1">
									<button
										type="button"
										onClick={() => void copyInvite(room.id)}
										className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-3 py-1.5 text-xs font-bold hover:bg-secondary/80 transition-colors"
									>
										<HugeiconsIcon icon={Share01Icon} size={14} />
										Copy Invite
									</button>
									<button
										type="button"
										disabled={!canEnter}
										onClick={() => window.open(`/room/${encodeURIComponent(room.id)}`, "_blank", "noopener,noreferrer")}
										className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-bold text-primary-foreground hover:opacity-90 transition-colors disabled:opacity-40"
									>
										<HugeiconsIcon icon={Video01Icon} size={14} />
										{room.status === "active" ? "Join Live" : "Open Room"}
									</button>
								</div>
								{isTooEarly && joinAllowedAtMs && startAtMs && (
									<p className="text-[11px] text-muted-foreground">
										Meeting time not reached. Participants can join{" "}
										{new Date(joinAllowedAtMs).toLocaleTimeString([], {
											hour: "2-digit",
											minute: "2-digit",
										})}
										, class starts{" "}
										{new Date(startAtMs).toLocaleTimeString([], {
											hour: "2-digit",
											minute: "2-digit",
										})}
										.
									</p>
								)}
							</div>
						);
					})}
				</div>
			)}
		</section>
	);
}
