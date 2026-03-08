import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import z from "zod";
import { ConferenceClient, type RoomResource } from "@q9labs/chalk-core";
import { fetchInternalAccessToken, getApiUrl, startMagicLink, createWebTokenProvider } from "../lib/internalAuth";
import { cn } from "../lib/utils";
import { HugeiconsIcon } from "@hugeicons/react";
import { 
  Video01Icon, 
  Calendar01Icon, 
  Clock01Icon, 
  File02Icon, 
  ZapIcon, 
  Search01Icon,
  Database01Icon,
  AlertCircleIcon,
  ArrowRight01Icon,
  CheckmarkCircle01Icon,
  InformationCircleIcon,
  Sun01Icon,
  Moon02Icon
} from "@hugeicons/core-free-icons";
import { useTheme } from "../context/theme";
import { toast, Toaster } from "sonner";
import { ScheduledClassesPanel } from "../features/classes/components/ScheduledClassesPanel";
import { Badge, Button } from "@q9labs/chalk-ui";
import { ChalkLogo } from "../components/ChalkLogo";
import { MeetingCardIllustration } from "../components/MeetingCardIllustration";

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
	const sdkClient = useMemo(
		() =>
			new ConferenceClient({
				apiUrl,
				tokenProvider: createWebTokenProvider(apiUrl),
			}),
		[apiUrl],
	);
  const { theme, toggleTheme } = useTheme();
	const [state, setState] = useState<
		| { kind: "loading" }
		| { kind: "login" }
		| { kind: "ready"; data: MeetingsResponse; token: string }
		| { kind: "error"; message: string }
	>({ kind: "loading" });

	const [email, setEmail] = useState("");
	const [emailSent, setEmailSent] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [expandedMeetingId, setExpandedMeetingId] = useState<string | null>(null);
	const [classRooms, setClassRooms] = useState<RoomResource[]>([]);
	const [classesLoading, setClassesLoading] = useState(false);
	const [classesError, setClassesError] = useState<string | null>(null);

	const refreshClasses = useCallback(async () => {
		setClassesLoading(true);
		setClassesError(null);
		try {
			const response = await sdkClient.listRooms({
				status: ["scheduled", "active"],
				limit: 100,
				offset: 0,
			});
			setClassRooms(response.rooms);
		} catch (err) {
			setClassesError(err instanceof Error ? err.message : "Failed to load classes");
		} finally {
			setClassesLoading(false);
		}
	}, [sdkClient]);

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

	useEffect(() => {
		if (state.kind !== "ready") {
			return;
		}
		void refreshClasses();
	}, [refreshClasses, state.kind]);

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
			<div className="min-h-screen bg-background flex items-center justify-center">
				<div className="flex flex-col items-center gap-6">
          <div className="w-10 h-10 border-4 border-primary border-t-transparent rounded-full animate-spin" />
					<p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground animate-pulse">Syncing Hub...</p>
				</div>
			</div>
		);
	}

	if (state.kind === "error") {
		return (
			<div className="min-h-screen bg-background flex items-center justify-center p-6 text-center">
				<div className="max-w-md space-y-8 bg-card p-12 rounded-[2.5rem] shadow-soft">
          <div className="mx-auto w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center text-destructive">
            <HugeiconsIcon icon={AlertCircleIcon} size={32} />
          </div>
					<h1 className="text-2xl font-black tracking-tight">Access Error</h1>
					<p className="text-muted-foreground font-medium">{state.message}</p>
          <Button 
            onClick={() => window.location.reload()}
            className="rounded-full px-10 h-12 font-bold"
          >
            Try Again
          </Button>
				</div>
			</div>
		);
	}

	if (state.kind === "login") {
		return (
			<div className="min-h-screen bg-background flex items-center justify-center p-6">
				<div className="w-full max-w-lg bg-card p-12 lg:p-16 rounded-[3rem] shadow-soft space-y-12">
					<div className="space-y-4 text-center">
            <div className="mx-auto w-16 h-16 bg-primary/10 rounded-3xl flex items-center justify-center text-primary mb-6">
              <HugeiconsIcon icon={ZapIcon} size={32} />
            </div>
						<h1 className="text-4xl font-black tracking-tight leading-none text-foreground">Welcome Back</h1>
						<p className="text-lg text-muted-foreground font-medium">
							Sign in to manage your edge records.
						</p>
					</div>

					<div className="space-y-6">
						<div className="space-y-3">
							<label className="text-[11px] font-black uppercase tracking-widest text-muted-foreground ml-4">Authorized Email</label>
							<input
								className="w-full rounded-2xl border bg-secondary/50 px-6 py-4 text-lg font-bold transition-all focus:ring-8 focus:ring-primary/5 focus:border-primary outline-none"
								placeholder="you@company.com"
								value={email}
								onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && email.trim() && sendLink()}
							/>
						</div>

	            <Button
	              onClick={sendLink}
	              size="lg"
	              className="w-full h-16 rounded-2xl font-black text-lg shadow-xl shadow-primary/20 premium-button"
	              disabled={!email.trim()}
	            >
              Get Access Link
            </Button>

            {emailSent && (
              <div className="flex gap-4 p-6 rounded-2xl bg-primary/5 text-sm text-primary font-bold items-center border border-primary/10 animate-in fade-in zoom-in-95">
                <HugeiconsIcon icon={InformationCircleIcon} size={20} className="shrink-0" />
                <p>{emailSent}</p>
              </div>
            )}
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="flex flex-col min-h-screen bg-background">
      <Toaster position="top-right" theme={theme} />
      
      {/* Refined Navigation Header */}
      <header className="sticky top-0 z-50 w-full bg-background/80 backdrop-blur-xl border-b border-border/50">
        <div className="mx-auto flex h-20 max-w-7xl items-center justify-between px-8">
          <div className="flex items-center gap-8">
            <Link to="/" className="hover:opacity-80 transition-opacity">
              <ChalkLogo />
            </Link>
            <div className="h-4 w-px bg-border hidden sm:block" />
            <h2 className="text-[11px] font-black text-muted-foreground uppercase tracking-widest hidden sm:block">Personal Hub</h2>
          </div>
          
          <div className="flex items-center gap-6">
            <div className="relative hidden md:block group">
              <HugeiconsIcon icon={Search01Icon} size={18} className="absolute left-5 top-1/2 -translate-y-1/2 text-muted-foreground group-focus-within:text-primary transition-colors" />
              <input 
                type="text" 
                placeholder="Find a session..." 
                className="h-11 w-72 rounded-xl border bg-secondary/50 pl-14 pr-6 text-sm font-bold focus:bg-background focus:ring-8 focus:ring-primary/5 outline-none transition-all"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <button
							onClick={toggleTheme}
							className="p-3 rounded-xl hover:bg-secondary/80 text-muted-foreground hover:text-foreground transition-all"
						>
							<HugeiconsIcon icon={theme === "dark" ? Sun01Icon : Moon02Icon} size={20} />
						</button>
            <Link to="/" className="hidden sm:flex h-11 items-center justify-center rounded-xl bg-primary px-6 text-sm font-bold text-primary-foreground shadow-lg shadow-primary/20 hover:scale-[1.02] active:scale-95 transition-all gap-2">
              <HugeiconsIcon icon={Video01Icon} size={18} />
              <span>New Meeting</span>
            </Link>
          </div>
        </div>
      </header>

			<main className="mx-auto w-full max-w-7xl p-8 lg:p-12 space-y-12 flex-1">
				{/* Soft Analytics Header */}
	        {stats && (
	          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
	            {[
	              { label: "Sessions", val: stats.totalMeetings, icon: Video01Icon },
	              { label: "Tasks", val: stats.totalActionItems, icon: CheckmarkCircle01Icon },
	              { label: "Storage", val: formatBytes(stats.totalSize), icon: Database01Icon },
	              { label: "At Risk", val: stats.expiringSoon, icon: AlertCircleIcon, warn: stats.expiringSoon > 0 }
	            ].map((s, i) => (
	              <div key={i} className={cn(
	                "bg-card p-8 rounded-[2rem] shadow-soft space-y-3 transition-all hover:translate-y-[-4px]",
                s.warn && "bg-destructive/[0.02] border border-destructive/10"
              )}>
	                <div className="flex items-center justify-between text-muted-foreground">
	                  <span className="text-[11px] font-black uppercase tracking-widest">{s.label}</span>
	                  <div className={cn("p-2 rounded-lg bg-secondary/80", s.warn && "bg-destructive/10 text-destructive")}>
	                    <HugeiconsIcon icon={s.icon} size={20} />
	                  </div>
	                </div>
                <div className={cn("text-3xl font-black tracking-tight tabular-nums", s.warn && "text-destructive")}>{s.val}</div>
              </div>
            ))}
          </div>
        )}

				{/* Records View */}
        <div className="space-y-10">
          <ScheduledClassesPanel
            client={sdkClient}
            rooms={classRooms}
            isLoading={classesLoading}
            error={classesError}
            onRefresh={refreshClasses}
          />

          <div className="space-y-8">
            <div className="flex items-center justify-between">
              <h3 className="text-3xl font-black tracking-tight flex items-center gap-4 text-foreground">
                Recent Records
                {search && <Badge variant="secondary" className="font-bold text-[10px] rounded-full px-3">{filteredMeetings.length} MATCHES</Badge>}
              </h3>
            </div>

            <div className="grid grid-cols-1 gap-6">
              {filteredMeetings.map((m) => {
                const isExpanded = expandedMeetingId === m.id;
                return (
                  <div key={m.id} className={cn(
                    "bg-card group relative p-10 rounded-[2.5rem] shadow-soft transition-all duration-500 overflow-hidden",
                    isExpanded ? "ring-1 ring-primary/20 border-primary/10" : "hover:shadow-heavy"
                  )}>
                    <MeetingCardIllustration active={m.status === 'ready'} />
                    <div className="relative z-10">
                      <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-8">
                      <div className="space-y-4 flex-1">
                        <div className="flex flex-wrap items-center gap-4">
                          <h4 className="text-2xl font-black tracking-tight leading-none group-hover:text-primary transition-colors">
                            {m.room_name || `Room ${m.room_id.slice(0, 8)}`}
                          </h4>
                          <Badge variant={m.status === "ready" ? "default" : "secondary"} className="rounded-full px-3 text-[10px] font-black uppercase tracking-widest shadow-sm">
                            {m.status}
                          </Badge>
                        </div>
                        
	                        <div className="flex flex-wrap items-center gap-6 text-[11px] font-bold text-muted-foreground uppercase tracking-widest">
	                          <span className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-secondary/50">
	                            <HugeiconsIcon icon={Calendar01Icon} size={14} className="text-primary" />
	                            {new Date(m.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
	                          </span>
	                          {m.duration_seconds && (
	                            <span className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-secondary/50">
	                              <HugeiconsIcon icon={Clock01Icon} size={14} className="text-primary" />
	                              {formatDuration(m.duration_seconds)}
	                            </span>
	                          )}
	                          {m.size_bytes && (
	                            <span className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-secondary/50">
	                              <HugeiconsIcon icon={Database01Icon} size={14} className="text-primary" />
	                              {formatBytes(m.size_bytes)}
	                            </span>
	                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-3 w-full lg:w-auto">
                        <button
                          disabled={m.status === "deleted" || m.status !== "ready"}
                          className="flex-1 lg:flex-none h-12 px-6 rounded-xl bg-primary/10 text-primary text-[11px] font-black uppercase tracking-widest hover:bg-primary hover:text-white transition-all disabled:opacity-30"
                          onClick={() => downloadRecording(m.id, state.token).then(() => toast.success("Sync complete")).catch(e => toast.error(e.message))}
                        >
                          Download
                        </button>
                        <button
                          disabled={m.status === "deleted" || m.status !== "ready"}
                          className="flex-1 lg:flex-none h-12 px-6 rounded-xl bg-secondary text-[11px] font-black uppercase tracking-widest hover:bg-foreground hover:text-background transition-all disabled:opacity-30"
                          onClick={() => createShareLink(m.id, state.token).then(() => toast.success("Link copied")).catch(e => toast.error(e.message))}
                        >
                          Share
                        </button>
                        <button 
                          onClick={() => setExpandedMeetingId(isExpanded ? null : m.id)}
                          className="p-3.5 rounded-xl bg-secondary/50 text-muted-foreground hover:text-primary transition-all"
                        >
                          <HugeiconsIcon icon={ArrowRight01Icon} size={20} className={cn("transition-transform duration-500", isExpanded && "rotate-90")} />
                        </button>
                      </div>
                    </div>
                    </div>

                    {isExpanded && (
                      <div className="pt-10 mt-10 border-t border-border/50 animate-in fade-in slide-in-from-top-4 duration-500 space-y-10">
	                        {m.transcript_summary ? (
	                          <div className="space-y-4">
	                            <div className="text-[11px] font-black text-primary uppercase tracking-widest flex items-center gap-2">
	                              <HugeiconsIcon icon={File02Icon} size={16} />
	                              Executive Summary
	                            </div>
                            <p className="text-xl text-muted-foreground leading-relaxed font-medium max-w-4xl">
                              {m.transcript_summary}
                            </p>
                          </div>
                        ) : (
                          <div className="p-8 rounded-2xl bg-secondary/30 text-muted-foreground text-sm font-bold border border-dashed text-center uppercase tracking-widest">
                            No transcript summary generated for this session.
                          </div>
                        )}

	                        {m.transcript_action_items && m.transcript_action_items.length > 0 && (
	                          <div className="space-y-6">
	                            <div className="text-[11px] font-black text-primary uppercase tracking-widest flex items-center gap-2">
	                              <HugeiconsIcon icon={CheckmarkCircle01Icon} size={16} />
	                              Action Items
	                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                              {m.transcript_action_items.map((item, idx) => (
                                <div key={idx} className="p-5 rounded-2xl bg-secondary/30 flex items-center gap-5 border border-border/50">
                                  <div className="h-8 w-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center font-black shrink-0">
                                    {idx + 1}
                                  </div>
                                  <span className="text-base font-bold text-foreground/80 leading-tight">{item}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {m.status === "deleted" && (
                      <div className="absolute inset-0 bg-background/60 backdrop-blur-[2px] rounded-[2.5rem] flex items-center justify-center pointer-events-none z-20">
                        <div className="bg-destructive/10 text-destructive px-8 py-2.5 rounded-full text-[11px] font-black uppercase tracking-widest border border-destructive/20 shadow-xl rotate-[-2deg]">
                          Purged from Edge
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}

	              {filteredMeetings.length === 0 && (
	                <div className="py-32 text-center space-y-6 bg-card rounded-[3rem] shadow-soft border border-dashed border-border/50">
	                  <div className="mx-auto w-20 h-20 rounded-3xl bg-secondary/50 flex items-center justify-center text-muted-foreground/30">
	                    <HugeiconsIcon icon={Video01Icon} size={40} />
	                  </div>
                  <div className="space-y-2">
                    <h3 className="text-2xl font-black tracking-tight">Records Empty</h3>
                    <p className="text-lg text-muted-foreground font-medium uppercase tracking-widest text-[11px]">Launch a session to begin logging</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
			</main>

      <footer className="py-16 px-12 border-t border-border/50 bg-secondary/10">
        <div className="mx-auto max-w-7xl flex flex-col md:flex-row items-center justify-between gap-10 text-[11px] font-black uppercase tracking-widest text-muted-foreground">
          <div className="flex items-center gap-3">
            <HugeiconsIcon icon={ZapIcon} size={16} className="text-primary animate-pulse" />
            <span>&copy; {new Date().getFullYear()} Chalk Edge Network</span>
          </div>
          <div className="flex items-center gap-10">
            <a href="#" className="hover:text-primary transition-all">Support</a>
            <a href="#" className="hover:text-primary transition-all">Security</a>
            <a href="#" className="hover:text-primary transition-all">Status</a>
          </div>
        </div>
      </footer>
		</div>
	);
}
