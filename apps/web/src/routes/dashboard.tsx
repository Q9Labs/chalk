import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import z from "zod";
import { fetchInternalAccessToken, getApiUrl, startMagicLink } from "../lib/internalAuth";
import { cn } from "../lib/utils";
import { HugeiconsIcon } from "@hugeicons/react";
import { 
  Video01Icon, 
  Download01Icon, 
  Share01Icon, 
  Calendar01Icon, 
  Clock01Icon, 
  File02Icon, 
  ZapIcon, 
  Search01Icon,
  Database01Icon,
  AlertCircleIcon,
  ArrowRight01Icon,
  CheckmarkCircle01Icon,
  InformationCircleIcon
} from "@hugeicons/core-free-icons";

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
	deleted_at?: string | null;
	size_bytes?: number | null;
	duration_seconds?: number | null;
	transcript_status?: string | null;
	transcript_summary?: string | null;
	transcript_action_items?: string[] | null;
};

type MeetingsResponse = {
	meetings: MeetingRow[];
	total: number;
	limit: number;
	offset: number;
};

function formatBytes(bytes: number) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function formatDuration(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

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
  const [search, setSearch] = useState("");

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const token = await fetchInternalAccessToken(apiUrl);
				const res = await fetch(`${apiUrl}/api/v1/internal/meetings?limit=100&offset=0`, {
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

	async function downloadRecording(recordingId: string, token: string) {
		const res = await fetch(`${apiUrl}/api/v1/recordings/${recordingId}/download`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		const data = (await res.json()) as any;
		if (res.status === 410) {
			throw new Error(data?.message || "recording has expired");
		}
		if (!res.ok) throw new Error(`download failed (${res.status})`);
		const url = data?.download_url;
		if (typeof url !== "string" || !url) {
			throw new Error(data?.message || "recording is not ready yet");
		}
		window.open(url, "_blank", "noopener,noreferrer");
	}

  const stats = useMemo(() => {
    if (state.kind !== "ready") return null;
    const meetings = state.data.meetings;
    const totalMeetings = state.data.total;
    const totalActionItems = meetings.reduce((acc, m) => acc + (m.transcript_action_items?.length || 0), 0);
    const totalSize = meetings.reduce((acc, m) => acc + (m.size_bytes || 0), 0);
    
    const now = new Date();
    const expiringSoon = meetings.filter(m => {
      const created = new Date(m.created_at);
      const diffDays = (now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24);
      return diffDays > 6 && diffDays < 7 && m.status !== "deleted";
    }).length;

    return { totalMeetings, totalActionItems, totalSize, expiringSoon };
  }, [state]);

  const filteredMeetings = useMemo(() => {
    if (state.kind !== "ready") return [];
    if (!search) return state.data.meetings;
    const s = search.toLowerCase();
    return state.data.meetings.filter(m => 
      (m.room_name || m.room_id).toLowerCase().includes(s) ||
      m.transcript_summary?.toLowerCase().includes(s) ||
      m.transcript_action_items?.some(ai => ai.toLowerCase().includes(s))
    );
  }, [state, search]);

	if (state.kind === "loading") {
		return (
			<div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
				<div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 border-4 border-primary border-t-transparent rounded-full animate-spin" />
					<p className="text-sm font-medium text-muted-foreground animate-pulse">Initializing dashboard…</p>
				</div>
			</div>
		);
	}

	if (state.kind === "error") {
		return (
			<div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
				<div className="w-full max-w-md space-y-4 text-center">
          <div className="mx-auto w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center text-destructive">
            <HugeiconsIcon icon={AlertCircleIcon} size={24} />
          </div>
					<h1 className="text-xl font-semibold">Failed to load dashboard</h1>
					<p className="text-sm text-muted-foreground">{state.message}</p>
          <button 
            onClick={() => window.location.reload()}
            className="rounded-full bg-primary px-6 py-2 text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity"
          >
            Try again
          </button>
				</div>
			</div>
		);
	}

	if (state.kind === "login") {
		return (
			<div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
				<div className="w-full max-w-md space-y-8 bg-card p-8 rounded-2xl border shadow-sm">
					<div className="space-y-2 text-center">
            <div className="mx-auto w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center text-primary mb-4">
              <HugeiconsIcon icon={ZapIcon} size={28} />
            </div>
						<h1 className="text-2xl font-bold tracking-tight">Host Dashboard</h1>
						<p className="text-sm text-muted-foreground">
							Sign in to manage your recordings and transcripts.
						</p>
					</div>

					<div className="space-y-4">
						<div className="space-y-2">
							<label className="text-sm font-medium px-1">Email address</label>
							<input
								className="w-full rounded-xl border bg-background px-4 py-3 text-sm transition-all focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none"
								placeholder="name@company.com"
								value={email}
								onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && email.trim() && sendLink()}
							/>
						</div>

            <button
              type="button"
              onClick={sendLink}
              className="w-full inline-flex items-center justify-center rounded-xl bg-primary px-4 py-3 text-primary-foreground text-sm font-semibold hover:opacity-90 transition-all disabled:opacity-50"
              disabled={!email.trim()}
            >
              Send magic link
            </button>

            {emailSent && (
              <div className="flex gap-2 p-3 rounded-lg bg-muted/50 text-xs text-muted-foreground items-start">
                <HugeiconsIcon icon={InformationCircleIcon} size={16} className="shrink-0 mt-0.5" />
                <p>{emailSent}</p>
              </div>
            )}
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="min-h-screen bg-background text-foreground">
      {/* Navigation Header */}
      <header className="sticky top-0 z-50 w-full border-b bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
          <div className="flex items-center gap-4">
            <Link to="/" className="flex items-center gap-2 font-bold text-xl tracking-tight">
              <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center text-primary-foreground shadow-sm shadow-primary/20">
                <HugeiconsIcon icon={ZapIcon} size={20} />
              </div>
              <span>Chalk</span>
            </Link>
            <div className="h-4 w-px bg-border hidden sm:block" />
            <h2 className="text-sm font-medium text-muted-foreground hidden sm:block">Dashboard</h2>
          </div>
          
          <div className="flex items-center gap-3">
            <div className="relative hidden md:block">
              <HugeiconsIcon icon={Search01Icon} size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input 
                type="text" 
                placeholder="Search meetings…" 
                className="h-9 w-64 rounded-full border bg-muted/50 pl-10 pr-4 text-sm focus:bg-background focus:ring-2 focus:ring-primary/20 outline-none transition-all"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <Link 
              to="/" 
              className="inline-flex h-9 items-center justify-center rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground shadow-sm hover:opacity-90 transition-all gap-1.5"
            >
              <HugeiconsIcon icon={Video01Icon} size={16} />
              <span>New Meeting</span>
            </Link>
          </div>
        </div>
      </header>

			<main className="mx-auto w-full max-w-7xl p-6 space-y-8">
				{/* Analytics Strip */}
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="p-4 rounded-2xl border bg-card shadow-sm space-y-1">
              <div className="flex items-center justify-between text-muted-foreground">
                <span className="text-xs font-medium uppercase tracking-wider">Meetings</span>
                <HugeiconsIcon icon={Video01Icon} size={18} />
              </div>
              <div className="text-2xl font-bold tabular-nums">{stats.totalMeetings}</div>
              <p className="text-[10px] text-muted-foreground">Lifetime recording count</p>
            </div>
            
            <div className="p-4 rounded-2xl border bg-card shadow-sm space-y-1">
              <div className="flex items-center justify-between text-muted-foreground">
                <span className="text-xs font-medium uppercase tracking-wider">Action Items</span>
                <HugeiconsIcon icon={CheckmarkCircle01Icon} size={18} />
              </div>
              <div className="text-2xl font-bold tabular-nums">{stats.totalActionItems}</div>
              <p className="text-[10px] text-muted-foreground">Extracted from transcripts</p>
            </div>

            <div className="p-4 rounded-2xl border bg-card shadow-sm space-y-1">
              <div className="flex items-center justify-between text-muted-foreground">
                <span className="text-xs font-medium uppercase tracking-wider">Storage</span>
                <HugeiconsIcon icon={Database01Icon} size={18} />
              </div>
              <div className="text-2xl font-bold tabular-nums">{formatBytes(stats.totalSize)}</div>
              <p className="text-[10px] text-muted-foreground">7-day auto-purge active</p>
            </div>

            <div className={cn(
              "p-4 rounded-2xl border shadow-sm space-y-1 transition-colors",
              stats.expiringSoon > 0 ? "bg-destructive/5 border-destructive/20 text-destructive" : "bg-card text-foreground"
            )}>
              <div className="flex items-center justify-between opacity-70">
                <span className="text-xs font-medium uppercase tracking-wider">At Risk</span>
                <HugeiconsIcon icon={AlertCircleIcon} size={18} />
              </div>
              <div className="text-2xl font-bold tabular-nums">{stats.expiringSoon}</div>
              <p className="text-[10px] opacity-70">Expires in &lt; 24 hours</p>
            </div>
          </div>
        )}

				{/* Meetings Feed */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold flex items-center gap-2">
              Recent Meetings
              {search && (
                <span className="text-sm font-normal text-muted-foreground">
                  · {filteredMeetings.length} results
                </span>
              )}
            </h3>
            <div className="flex items-center gap-2">
              {/* Optional: Filter chips could go here */}
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {filteredMeetings.map((m) => (
              <div key={m.id} className="group relative flex flex-col rounded-2xl border bg-card p-5 shadow-sm hover:shadow-md transition-all hover:border-primary/20">
                <div className="flex items-start justify-between mb-4">
                  <div className="space-y-1">
                    <h4 className="font-bold text-base group-hover:text-primary transition-colors">
                      {m.room_name || `Room ${m.room_id.slice(0, 8)}`}
                    </h4>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <HugeiconsIcon icon={Calendar01Icon} size={14} />
                        {new Date(m.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </span>
                      {m.duration_seconds && (
                        <span className="flex items-center gap-1">
                          <HugeiconsIcon icon={Clock01Icon} size={14} />
                          {formatDuration(m.duration_seconds)}
                        </span>
                      )}
                      {m.size_bytes && (
                        <span className="flex items-center gap-1">
                          <HugeiconsIcon icon={Database01Icon} size={14} />
                          {formatBytes(m.size_bytes)}
                        </span>
                      )}
                    </div>
                  </div>
                  
                  <div className={cn(
                    "px-2 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider border",
                    m.status === "ready" ? "bg-primary/10 border-primary/20 text-primary" : 
                    m.status === "deleted" ? "bg-muted text-muted-foreground border-border" :
                    "bg-orange-500/10 border-orange-500/20 text-orange-600"
                  )}>
                    {m.status}
                  </div>
                </div>

                {/* Intelligence Layer */}
                <div className="flex-1 space-y-4 mb-6">
                  {m.transcript_summary ? (
                    <div className="space-y-1.5">
                      <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest flex items-center gap-1">
                        <HugeiconsIcon icon={File02Icon} size={12} />
                        Summary
                      </div>
                      <p className="text-sm text-muted-foreground line-clamp-2 leading-relaxed">
                        {m.transcript_summary}
                      </p>
                    </div>
                  ) : m.status !== "deleted" && (
                    <div className="py-2 px-3 rounded-xl bg-muted/30 border border-dashed text-xs text-muted-foreground italic">
                      No summary available yet.
                    </div>
                  )}

                  {m.transcript_action_items && m.transcript_action_items.length > 0 && (
                    <div className="space-y-2">
                      <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest flex items-center gap-1">
                        <HugeiconsIcon icon={CheckmarkCircle01Icon} size={12} />
                        Key Actions
                      </div>
                      <ul className="space-y-1.5">
                        {m.transcript_action_items.slice(0, 2).map((item, idx) => (
                          <li key={idx} className="flex items-start gap-2 text-xs text-foreground/80">
                            <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0 mt-1.5" />
                            <span className="line-clamp-1">{item}</span>
                          </li>
                        ))}
                        {m.transcript_action_items.length > 2 && (
                          <li className="text-[10px] font-medium text-primary pl-3.5">
                            + {m.transcript_action_items.length - 2} more items
                          </li>
                        )}
                      </ul>
                    </div>
                  )}
                </div>

                {/* Actions */}
                <div className="flex items-center justify-between pt-4 border-t mt-auto">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={m.status === "deleted" || m.status !== "ready"}
                      className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-3 py-1.5 text-xs font-semibold hover:bg-secondary/80 transition-colors disabled:opacity-30"
                      onClick={async () => {
                        try {
                          await downloadRecording(m.id, state.token);
                        } catch (e) {
                          alert(e instanceof Error ? e.message : String(e));
                        }
                      }}
                    >
                      <HugeiconsIcon icon={Download01Icon} size={14} />
                      Download
                    </button>
                    <button
                      type="button"
                      disabled={m.status === "deleted" || m.status !== "ready"}
                      className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-3 py-1.5 text-xs font-semibold hover:bg-secondary/80 transition-colors disabled:opacity-30"
                      onClick={async () => {
                        try {
                          const url = await createShareLink(m.id, state.token);
                          // In a real app, maybe show a nice toast here
                          alert(`Share link copied to clipboard!\n${url}`);
                        } catch (e) {
                          alert(e instanceof Error ? e.message : String(e));
                        }
                      }}
                    >
                      <HugeiconsIcon icon={Share01Icon} size={14} />
                      Share
                    </button>
                  </div>
                  
                  <button className="flex items-center gap-1 text-xs font-bold text-muted-foreground hover:text-primary transition-colors group/link">
                    View Details
                    <HugeiconsIcon icon={ArrowRight01Icon} size={14} className="group-hover/link:translate-x-0.5 transition-transform" />
                  </button>
                </div>

                {m.status === "deleted" && (
                  <div className="absolute inset-0 bg-background/40 backdrop-blur-[1px] rounded-2xl flex items-center justify-center pointer-events-none">
                    <div className="bg-muted px-4 py-1 rounded-full border shadow-sm text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                      Purged
                    </div>
                  </div>
                )}
              </div>
            ))}

            {filteredMeetings.length === 0 && (
              <div className="col-span-full py-20 text-center space-y-4">
                <div className="mx-auto w-16 h-16 rounded-full bg-muted flex items-center justify-center text-muted-foreground">
                  <HugeiconsIcon icon={Video01Icon} size={32} />
                </div>
                <div className="space-y-1">
                  <h3 className="font-semibold text-lg">No meetings found</h3>
                  <p className="text-sm text-muted-foreground max-w-xs mx-auto">
                    {search ? "No results match your search query. Try different keywords." : "Start your first meeting to see it here on the dashboard."}
                  </p>
                </div>
                {search && (
                   <button 
                    onClick={() => setSearch("")}
                    className="text-sm font-bold text-primary hover:underline"
                   >
                    Clear search
                   </button>
                )}
              </div>
            )}
          </div>
        </div>
			</main>

      <footer className="py-12 px-6 border-t mt-20">
        <div className="mx-auto max-w-7xl flex flex-col md:flex-row items-center justify-between gap-6 text-muted-foreground text-xs font-medium">
          <div className="flex items-center gap-2">
            <HugeiconsIcon icon={ZapIcon} size={14} className="text-primary" />
            <span>&copy; 2026 Chalk Education. All rights reserved.</span>
          </div>
          <div className="flex items-center gap-6">
            <a href="#" className="hover:text-foreground">Terms</a>
            <a href="#" className="hover:text-foreground">Privacy</a>
            <a href="#" className="hover:text-foreground">Status</a>
            <a href="#" className="hover:text-foreground">Help</a>
          </div>
        </div>
      </footer>
		</div>
	);
}

