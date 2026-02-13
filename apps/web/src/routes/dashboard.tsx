import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import z from "zod";
import { fetchInternalAccessToken, getApiUrl, startMagicLink } from "../lib/internalAuth";

export const Route = createFileRoute("/dashboard")({
	component: DashboardPage,
	validateSearch: z.object({
		limit: z.string().optional(),
		offset: z.string().optional(),
	}),
});

type MeetingRow = {
	id: string;
	room_id: string;
	room_name?: string | null;
	status: string;
	created_at: string;
	size_bytes?: number | null;
	duration_seconds?: number | null;
	transcript_status?: string | null;
};

type MeetingsResponse = {
	meetings: MeetingRow[];
	total: number;
	limit: number;
	offset: number;
};

function DashboardPage() {
	const apiUrl = useMemo(() => getApiUrl(), []);
	const [state, setState] = useState<
		| { kind: "loading" }
		| { kind: "login" }
		| { kind: "ready"; data: MeetingsResponse; token: string }
		| { kind: "error"; message: string }
	>({ kind: "loading" });

	const [email, setEmail] = useState("");
	const [emailSent, setEmailSent] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const token = await fetchInternalAccessToken(apiUrl);
				const res = await fetch(`${apiUrl}/api/v1/internal/meetings?limit=50&offset=0`, {
					headers: { Authorization: `Bearer ${token}` },
				});
				if (res.status === 401) {
					if (cancelled) return;
					setState({ kind: "login" });
					return;
				}
				if (!res.ok) throw new Error(`failed to load (${res.status})`);
				const data = (await res.json()) as MeetingsResponse;
				if (cancelled) return;
				setState({ kind: "ready", data, token });
			} catch (e) {
				if (cancelled) return;
				setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [apiUrl]);

	async function sendLink() {
		setEmailSent(null);
		try {
			await startMagicLink(apiUrl, email);
			setEmailSent("Check your email for a sign-in link.");
		} catch (e) {
			setEmailSent(e instanceof Error ? e.message : String(e));
		}
	}

	async function createShareLink(recordingId: string, token: string) {
		const res = await fetch(`${apiUrl}/api/v1/recordings/${recordingId}/share`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
		});
		if (!res.ok) throw new Error(`share failed (${res.status})`);
		const data = (await res.json()) as { share_token: string };
		const url = `${window.location.origin}/share/${data.share_token}`;
		await navigator.clipboard.writeText(url);
		return url;
	}

	if (state.kind === "loading") {
		return (
			<div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
				<div className="w-full max-w-md space-y-2">
					<h1 className="text-xl font-semibold">Dashboard</h1>
					<p className="text-sm text-muted-foreground">Loading...</p>
				</div>
			</div>
		);
	}

	if (state.kind === "error") {
		return (
			<div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
				<div className="w-full max-w-md space-y-3">
					<h1 className="text-xl font-semibold">Dashboard</h1>
					<pre className="rounded-lg bg-muted p-3 text-xs whitespace-pre-wrap">
						{state.message}
					</pre>
				</div>
			</div>
		);
	}

	if (state.kind === "login") {
		return (
			<div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
				<div className="w-full max-w-md space-y-4">
					<div className="space-y-1">
						<h1 className="text-xl font-semibold">Host dashboard</h1>
						<p className="text-sm text-muted-foreground">
							Sign in to view recordings, transcripts, and past meetings.
						</p>
					</div>

					<div className="space-y-2">
						<label className="text-sm font-medium">Email</label>
						<input
							className="w-full rounded-md border bg-background px-3 py-2 text-sm"
							placeholder="you@company.com"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
						/>
					</div>

					<button
						type="button"
						onClick={sendLink}
						className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-primary-foreground text-sm font-medium"
						disabled={!email.trim()}
					>
						Send magic link
					</button>

					{emailSent && (
						<p className="text-sm text-muted-foreground">{emailSent}</p>
					)}
				</div>
			</div>
		);
	}

	return (
		<div className="min-h-screen bg-background text-foreground p-6">
			<div className="mx-auto w-full max-w-5xl space-y-6">
				<div className="flex items-end justify-between gap-4">
					<div className="space-y-1">
						<h1 className="text-2xl font-semibold">Dashboard</h1>
						<p className="text-sm text-muted-foreground">
							Recordings are deleted after 7 days.
						</p>
					</div>
					<a
						href="/"
						className="text-sm text-muted-foreground hover:text-foreground"
					>
						New meeting
					</a>
				</div>

				<div className="overflow-x-auto rounded-lg border">
					<table className="w-full text-sm">
						<thead className="bg-muted/50 text-left">
							<tr>
								<th className="p-3 font-medium">Room</th>
								<th className="p-3 font-medium">Recording</th>
								<th className="p-3 font-medium">Transcript</th>
								<th className="p-3 font-medium"></th>
							</tr>
						</thead>
						<tbody>
							{state.data.meetings.map((m) => (
								<tr key={m.id} className="border-t">
									<td className="p-3">
										<div className="font-medium">{m.room_name || m.room_id}</div>
										<div className="text-xs text-muted-foreground">
											{new Date(m.created_at).toLocaleString()}
										</div>
									</td>
									<td className="p-3">
										<div className="font-medium">{m.status}</div>
									</td>
									<td className="p-3">
										<div className="font-medium">
											{m.transcript_status || "none"}
										</div>
									</td>
									<td className="p-3 text-right">
										<button
											type="button"
											className="rounded-md border px-3 py-1.5 text-xs hover:bg-muted"
											onClick={async () => {
												const url = await createShareLink(m.id, state.token);
												alert(`Copied: ${url}`);
											}}
										>
											Copy share link
										</button>
									</td>
								</tr>
							))}
							{state.data.meetings.length === 0 && (
								<tr>
									<td className="p-6 text-sm text-muted-foreground" colSpan={4}>
										No meetings yet.
									</td>
								</tr>
							)}
						</tbody>
					</table>
				</div>
			</div>
		</div>
	);
}

