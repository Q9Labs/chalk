import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import z from "zod";
import { ConferenceClient, type RoomResource } from "@q9labs/chalk-core";
import { fetchInternalAccessToken, getApiUrl, startMagicLink, createWebTokenProvider } from "../lib/internalAuth";
import { cn } from "../lib/utils";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Video01Icon,
	Download01Icon,
	Share01Icon,
	Search01Icon,
	AlertCircleIcon,
	InformationCircleIcon,
	Sun01Icon,
	Moon02Icon,
	Book02Icon,
	HelpCircleIcon,
	UserCircleIcon,
	AiChat02Icon,
	AlignLeftIcon,
} from "@hugeicons/core-free-icons";
import { useTheme } from "../context/theme";
import { toast, Toaster } from "sonner";
import { ScheduledClassesPanel } from "../features/classes/components/ScheduledClassesPanel";
import { Badge, Button } from "@q9labs/chalk-ui";
import { ChalkLogo } from "../components/ChalkLogo";

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
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
				if (!res.ok) throw new Error(`Failed to load meetings (${res.status})`);
				const data = (await res.json()) as MeetingsResponse;
				if (cancelled) return;
					setState({ kind: "ready", data, token });
					const firstMeeting = data.meetings.at(0);
					if (firstMeeting) setSelectedId(firstMeeting.id);
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
		if (state.kind !== "ready") return;
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
		if (res.status === 410) throw new Error(data?.message || "recording has expired");
		if (!res.ok) throw new Error(`download failed (${res.status})`);
		const url = data?.download_url;
		if (typeof url !== "string" || !url) throw new Error(data?.message || "recording is not ready yet");
		window.open(url, "_blank", "noopener,noreferrer");
	}

  const selectedMeeting = useMemo(() => {
    if (state.kind !== "ready") return null;
    const selectedMeetingId = selectedId ?? state.data.meetings.at(0)?.id;
    if (!selectedMeetingId) return null;
    return state.data.meetings.find((m) => m.id === selectedMeetingId) ?? null;
  }, [state, selectedId]);

  const stats = useMemo(() => {
    if (state.kind !== "ready") return null;
    const meetings = state.data.meetings || [];
    return {
      total: state.data.total || 0,
      tasks: meetings.reduce((acc, m) => acc + (m.transcript_action_items?.length || 0), 0),
      storage: meetings.reduce((acc, m) => acc + (m.size_bytes || 0), 0)
    };
  }, [state]);

	if (state.kind === "loading") {
		return (
			<div className="min-h-screen bg-background flex items-center justify-center">
				<div className="flex flex-col items-center gap-6">
          <div className="w-10 h-10 border-2 border-primary border-t-transparent rounded-full animate-spin" />
					<p className="text-[11px] font-black uppercase tracking-widest text-muted-foreground animate-pulse">Establishing Intelligence Link...</p>
				</div>
			</div>
		);
	}

  if (state.kind === "error") {
		return (
			<div className="min-h-screen bg-background flex items-center justify-center p-12 text-center">
				<div className="max-w-md space-y-8 bg-card p-12 rounded-[2.5rem] shadow-heavy border border-border/50">
          <div className="mx-auto w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center text-destructive">
            <HugeiconsIcon icon={AlertCircleIcon} size={32} />
          </div>
					<h1 className="text-2xl font-black tracking-tight text-foreground">Sync Failed</h1>
					<p className="text-muted-foreground font-medium">{state.message}</p>
          <Button 
            onClick={() => window.location.reload()}
            className="rounded-full px-12 h-14 font-black"
          >
            Retry Connection
          </Button>
				</div>
			</div>
		);
	}

	if (state.kind === "login") {
		return (
			<div className="min-h-screen bg-background flex items-center justify-center p-6 relative selection:bg-primary/20">
        <div className="fixed top-[-10%] left-[-10%] w-[40%] h-[40%] bg-primary/10 rounded-full blur-[120px]" />
				<div className="w-full max-w-md bg-card p-10 lg:p-12 rounded-[2.5rem] shadow-heavy border border-border/50 relative z-10 space-y-10">
					<div className="space-y-3 text-center">
            <ChalkLogo className="justify-center mb-6 scale-110" />
						<h1 className="text-3xl font-black tracking-tight text-foreground">Sign in to Chalk</h1>
						<p className="text-muted-foreground font-medium text-sm">Welcome back. Enter your email to see your meetings.</p>
					</div>
					<div className="space-y-6">
            <div className="space-y-2">
              <label className="text-[11px] font-black uppercase tracking-widest text-muted-foreground ml-1">Email address</label>
              <input
                className="w-full rounded-2xl border border-border bg-secondary/30 px-6 py-4 text-base font-bold transition-all focus:ring-8 focus:ring-primary/5 focus:border-primary outline-none"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && email.trim() && sendLink()}
              />
            </div>
	            <Button onClick={sendLink} size="lg" disabled={!email.trim()} className="w-full h-14 rounded-2xl font-black text-sm uppercase tracking-widest shadow-xl shadow-primary/20 premium-button">
	              Continue
	            </Button>
	            {emailSent && (
	              <div className="p-4 rounded-2xl bg-primary/5 border border-primary/10 flex items-center gap-3 animate-in fade-in zoom-in-95">
	                <HugeiconsIcon icon={InformationCircleIcon} size={20} className="text-primary shrink-0" />
	                <p className="text-xs text-primary font-bold">{emailSent}</p>
	              </div>
	            )}
					</div>
          <div className="pt-6 border-t border-border/50 text-center opacity-50"><p className="text-[10px] font-black text-muted-foreground uppercase tracking-widest italic">Protected & Encrypted</p></div>
				</div>
			</div>
		);
	}

	return (
		<div className="flex flex-col h-screen bg-background selection:bg-primary/20 overflow-hidden">
      <Toaster position="top-right" theme={theme} />
      
      {/* Refined Command Header */}
      <header className="relative z-50 flex h-20 items-center justify-between px-8 border-b border-border/50 bg-background/80 backdrop-blur-xl">
        <div className="flex items-center gap-8">
          <Link to="/" className="hover:opacity-80 transition-opacity">
            <ChalkLogo />
          </Link>
          <div className="h-4 w-px bg-border" />
          <nav className="flex items-center gap-6">
            <div className="relative group">
	              <HugeiconsIcon icon={Search01Icon} size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground group-focus-within:text-primary transition-colors" />
              <input 
                type="text" 
                placeholder="Search your library..." 
                className="h-10 w-72 rounded-xl border border-border bg-secondary/50 pl-11 pr-4 text-xs font-bold focus:bg-background focus:ring-8 focus:ring-primary/5 outline-none transition-all"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </nav>
        </div>
        
        <div className="flex items-center gap-6">
          <button onClick={toggleTheme} className="p-3 rounded-xl hover:bg-secondary/80 text-muted-foreground hover:text-foreground transition-all">
            <HugeiconsIcon icon={theme === "dark" ? Sun01Icon : Moon02Icon} size={20} />
          </button>
          <Link to="/" className="h-11 px-6 rounded-xl bg-primary text-[11px] font-black uppercase tracking-widest text-primary-foreground shadow-lg shadow-primary/20 hover:scale-[1.02] active:scale-95 transition-all gap-2 flex items-center">
	            <HugeiconsIcon icon={Video01Icon} size={16} /> New Room
          </Link>
          <div className="w-10 h-10 rounded-xl bg-secondary flex items-center justify-center border border-border">
            <HugeiconsIcon icon={UserCircleIcon} size={24} className="text-muted-foreground" />
          </div>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* Left: The Narrow Rail (380px) */}
        <aside className="w-[380px] border-r border-border/50 flex flex-col bg-background/50 relative">
          <div className="p-8 border-b border-border/50 space-y-8">
            <div className="flex items-center justify-between">
              <h2 className="text-[11px] font-black uppercase tracking-[0.3em] text-muted-foreground">My Meetings</h2>
              <div className="px-2 py-0.5 rounded bg-primary/10 text-primary text-[10px] font-black">{state.data?.meetings?.length || 0}</div>
            </div>
            
            {stats && (
              <div className="flex gap-10">
                {[
                  { label: "Total", val: stats.total },
                  { label: "Tasks", val: stats.tasks },
                  { label: "Storage", val: formatBytes(stats.storage).split(' ')[0] }
                ].map((s, i) => (
                  <div key={i} className="space-y-1">
                    <div className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/50">{s.label}</div>
                    <div className="text-lg font-black tabular-nums">{s.val}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-2 scrollbar-hide">
            <ScheduledClassesPanel client={sdkClient} rooms={classRooms} isLoading={classesLoading} error={classesError} onRefresh={refreshClasses} />
            
            {(state.data?.meetings || []).filter(m => (m.room_name || '').toLowerCase().includes(search.toLowerCase())).map((m) => {
              const isActive = selectedId === m.id;
              return (
                <button
                  key={m.id}
                  onClick={() => setSelectedId(m.id)}
                  className={cn(
                    "w-full text-left p-6 rounded-[2rem] transition-all duration-500 relative group overflow-hidden",
                    isActive ? "bg-card shadow-heavy ring-1 ring-primary/10 border border-primary/5" : "hover:bg-secondary/40"
                  )}
                >
                  {isActive && <div className="absolute left-0 top-1/4 bottom-1/4 w-1 bg-primary rounded-r-full" />}
                  <div className="flex flex-col gap-3 min-w-0">
                    <div className="flex items-center gap-3">
                      <div className={cn("w-2 h-2 rounded-full shrink-0", m.status === 'ready' ? 'bg-primary shadow-[0_0_10px_rgba(27,182,166,0.5)]' : 'bg-muted-foreground/20')} />
                      <h4 className="font-bold text-sm uppercase tracking-tight truncate leading-none text-foreground/90">{m.room_name || `Untitled Session`}</h4>
                    </div>
                    <div className="flex items-center gap-6 text-[10px] font-black text-muted-foreground/60 uppercase tracking-widest pl-5">
                      <span className="flex items-center gap-1.5">{new Date(m.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
                      <span className="flex items-center gap-1.5">{formatDuration(m.duration_seconds || 0)}</span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        {/* Right: The Mosaic Intelligence */}
        <main className="flex-1 bg-secondary/5 overflow-y-auto p-12 lg:p-16 relative scrollbar-hide">
          <div className="fixed top-20 right-0 w-1/2 h-full fluid-gradient -z-10 pointer-events-none" />
          
          {selectedMeeting ? (
            <div className="max-w-5xl mx-auto space-y-12 animate-in fade-in slide-in-from-right-8 duration-700">
              {/* Header Grid */}
              <div className="flex flex-col lg:flex-row items-start lg:items-end justify-between gap-8 pb-12 border-b border-border/50">
                <div className="space-y-6">
                  <div className="flex items-center gap-4">
                    <Badge variant={selectedMeeting.status === 'ready' ? "default" : "secondary"} className="rounded-full px-4 py-1 text-[10px] font-black uppercase tracking-widest">
                      {selectedMeeting.status === 'ready' ? 'Intelligence Ready' : 'Processing...'}
                    </Badge>
                    <span className="text-[10px] font-black text-muted-foreground uppercase tracking-widest opacity-50">Node: {selectedMeeting.id.slice(0, 8)}</span>
                  </div>
                  <h3 className="text-6xl lg:text-8xl font-black tracking-tighter uppercase italic leading-[0.85] text-foreground mix-blend-plus-lighter">
                    {selectedMeeting.room_name || 'Untitled Meeting'}
                  </h3>
                </div>

                <div className="flex gap-3">
                  <button
                    disabled={selectedMeeting.status !== 'ready'}
                    onClick={() => downloadRecording(selectedMeeting.id, state.token).then(() => toast.success("Download started")).catch(e => toast.error(e.message))}
                    className="h-14 px-8 rounded-2xl bg-primary text-primary-foreground font-black uppercase tracking-widest text-[11px] shadow-xl shadow-primary/20 premium-button disabled:opacity-30 flex items-center gap-2"
                  >
	                    <HugeiconsIcon icon={Download01Icon} size={18} /> Download
                  </button>
                  <button
                    disabled={selectedMeeting.status !== 'ready'}
                    onClick={() => createShareLink(selectedMeeting.id, state.token).then(() => toast.success("Share link copied")).catch(e => toast.error(e.message))}
                    className="h-14 px-8 rounded-2xl bg-card border border-border/50 text-foreground font-black uppercase tracking-widest text-[11px] shadow-soft hover:shadow-heavy transition-all disabled:opacity-30 flex items-center gap-2"
                  >
	                    <HugeiconsIcon icon={Share01Icon} size={18} /> Share
                  </button>
                </div>
              </div>

              {/* Mosaic Bento Grid */}
              <div className="grid lg:grid-cols-12 gap-6">
                {/* Meta Panel */}
                <div className="lg:col-span-4 bento-card flex flex-col justify-between aspect-square lg:aspect-auto">
                  <div className="space-y-2">
                    <div className="text-[10px] font-black text-primary uppercase tracking-[0.4em] mb-4 flex items-center gap-2">
	                      <HugeiconsIcon icon={InformationCircleIcon} size={14} /> Session_Meta
                    </div>
                    <div className="space-y-6">
                      <div>
                        <div className="text-[9px] font-black text-muted-foreground uppercase tracking-widest mb-1">Created</div>
                        <div className="text-xl font-bold">{new Date(selectedMeeting.created_at).toLocaleString()}</div>
                      </div>
                      <div>
                        <div className="text-[9px] font-black text-muted-foreground uppercase tracking-widest mb-1">Duration</div>
                        <div className="text-xl font-bold">{formatDuration(selectedMeeting.duration_seconds || 0)}</div>
                      </div>
                      <div>
                        <div className="text-[9px] font-black text-muted-foreground uppercase tracking-widest mb-1">Data Weight</div>
                        <div className="text-xl font-bold">{formatBytes(selectedMeeting.size_bytes || 0)}</div>
                      </div>
                    </div>
                  </div>
                  <div className="pt-8 flex items-center gap-3 text-[10px] font-black text-muted-foreground uppercase tracking-widest opacity-40">
	                    <HugeiconsIcon icon={AlertCircleIcon} size={14} /> EPHEMERAL_EDGE_SYNC
                  </div>
                </div>

                {/* Summary Panel */}
                <div className="lg:col-span-8 bento-card space-y-8 bg-gradient-to-br from-card to-secondary/30">
                  <div className="text-[10px] font-black text-primary uppercase tracking-[0.4em] flex items-center gap-2">
	                    <HugeiconsIcon icon={AiChat02Icon} size={16} /> Meeting_Summary
                  </div>
                  <p className="text-3xl lg:text-4xl font-black text-foreground/90 leading-tight italic tracking-tight">
                    "{selectedMeeting.transcript_summary || 'Our intelligence models are currently digesting this meeting. Please wait.'}"
                  </p>
                  <div className="flex gap-4 pt-4">
                    <Badge variant="secondary" className="rounded-full px-3 text-[9px] font-bold">SENTIMENT: NEUTRAL</Badge>
                    <Badge variant="secondary" className="rounded-full px-3 text-[9px] font-bold">TOPIC: COLLABORATION</Badge>
                  </div>
                </div>

                {/* Action Items Panel */}
                <div className="lg:col-span-12 bento-card space-y-10">
                  <div className="flex items-center justify-between">
                    <div className="text-[10px] font-black text-primary uppercase tracking-[0.4em] flex items-center gap-2">
	                      <HugeiconsIcon icon={AlignLeftIcon} size={16} /> Action_Ledger
                    </div>
                    <div className="text-[9px] font-black text-muted-foreground uppercase tracking-widest">{selectedMeeting.transcript_action_items?.length || 0} ITEMS EXTRACTED</div>
                  </div>
                  
                  <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {selectedMeeting.transcript_action_items && selectedMeeting.transcript_action_items.length > 0 ? (
                      selectedMeeting.transcript_action_items.map((item, idx) => (
                        <div key={idx} className="p-6 rounded-[2rem] bg-secondary/30 border border-border/20 flex flex-col gap-4 group/item hover:bg-primary/5 transition-all">
                          <div className="w-8 h-8 rounded-xl bg-background border border-border/50 text-primary flex items-center justify-center text-xs font-black shadow-sm group-hover/item:scale-110 transition-transform">
                            {idx + 1}
                          </div>
                          <span className="text-sm font-bold text-foreground/80 uppercase tracking-tight leading-snug">{item}</span>
                        </div>
                      ))
                    ) : (
                      <div className="col-span-full p-12 rounded-[2rem] bg-secondary/20 border border-dashed border-border/50 text-center opacity-40 italic text-sm">No action items found.</div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="h-full flex items-center justify-center">
              <div className="text-center space-y-8 max-w-md">
                <div className="w-24 h-24 bg-card rounded-[3rem] shadow-soft border border-border/50 flex items-center justify-center mx-auto opacity-20 relative">
                  <div className="absolute inset-0 bg-primary/10 rounded-full animate-ping" />
	                  <HugeiconsIcon icon={Video01Icon} size={48} className="text-primary relative z-10" />
                </div>
                <div className="space-y-2">
                  <h3 className="text-3xl font-black uppercase tracking-tighter opacity-20 italic">Select a session <br /> to unfold intelligence</h3>
                  <p className="text-[10px] font-black uppercase tracking-[0.3em] opacity-20">Your global edge library</p>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* Modern Float HUD */}
      <footer className="fixed bottom-8 left-[380px] right-0 flex justify-center pointer-events-none">
        <div className="glass-panel px-10 h-14 rounded-full flex items-center gap-10 pointer-events-auto border border-white/10 shadow-2xl">
          <a href="/docs" className="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground hover:text-primary transition-colors flex items-center gap-2">
	            <HugeiconsIcon icon={Book02Icon} size={16} /> Guides
          </a>
          <div className="w-px h-4 bg-border/50" />
          <a href="#" className="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground hover:text-primary transition-colors flex items-center gap-2">
	            <HugeiconsIcon icon={HelpCircleIcon} size={16} /> Support
          </a>
          <div className="w-px h-4 bg-border/50" />
          <div className="flex items-center gap-3">
            <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            <span className="text-[10px] font-black uppercase tracking-[0.2em] text-primary">Connected</span>
          </div>
        </div>
      </footer>
		</div>
	);
}
