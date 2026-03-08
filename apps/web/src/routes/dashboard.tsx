import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import z from "zod";
import { fetchInternalAccessToken, getApiUrl, startMagicLink } from "../lib/internalAuth";
import { cn } from "../lib/utils";
import { HugeiconsIcon } from "@hugeicons/react";
import { 
  Video01Icon, 
  Calendar01Icon, 
  Clock01Icon, 
  File02Icon, 
  Search01Icon,
  Database01Icon,
  ArrowRight01Icon,
  CheckmarkCircle01Icon,
  InformationCircleIcon,
  Sun01Icon,
  Moon02Icon
} from "@hugeicons/core-free-icons";
import { useTheme } from "../context/theme";
import { toast, Toaster } from "sonner";
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
  const { theme, toggleTheme } = useTheme();
  const mainRef = useRef<HTMLElement>(null);
	const [state, setState] = useState<
		| { kind: "loading" }
		| { kind: "login" }
		| { kind: "ready"; data: MeetingsResponse; token: string }
		| { kind: "error"; message: string }
	>({ kind: "loading" });

	const [email, setEmail] = useState("");
	const [emailSent, setEmailSent] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selectedMeetingId, setSelectedMeetingId] = useState<string | null>(null);

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

		const timeoutId = window.setTimeout(() => {
			if (!mainRef.current) {
				return;
			}
			mainRef.current.scrollTo({
				left: 500 - window.innerWidth / 2 + 160,
				top: 500 - window.innerHeight / 2,
				behavior: "smooth",
			});
		}, 500);

		return () => window.clearTimeout(timeoutId);
	}, [state.kind]);

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
		const data = (await res.json()) as {
			download_url?: string;
			message?: string;
		};
		if (res.status === 410) {
			throw new Error(data.message || "recording has expired");
		}
		if (!res.ok) throw new Error(`download failed (${res.status})`);
		if (!data.download_url) {
			throw new Error(data.message || "recording is not ready yet");
		}
		window.open(data.download_url, "_blank", "noopener,noreferrer");
	}

  const selectedMeeting = useMemo(() => {
    if (state.kind !== "ready") return null;
    return state.data.meetings.find(m => m.id === selectedMeetingId);
  }, [state, selectedMeetingId]);
  const readyState = state.kind === "ready" ? state : null;

  const stats = useMemo(() => {
    if (state.kind !== "ready") return null;
    const meetings = state.data.meetings;
    const totalMeetings = state.data.total;
    const totalActionItems = meetings.reduce((acc, m) => acc + (m.transcript_action_items?.length || 0), 0);
    const totalSize = meetings.reduce((acc, m) => acc + (m.size_bytes || 0), 0);
    return { totalMeetings, totalActionItems, totalSize };
  }, [state]);

	if (state.kind === "loading") {
		return (
			<div className="min-h-screen bg-background flex items-center justify-center">
        <div className="portal-grid fixed inset-0 opacity-10" />
				<div className="flex flex-col items-center gap-6">
          <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin" />
					<p className="text-[10px] font-black uppercase tracking-[0.4em] text-primary animate-pulse">Syncing Portal</p>
				</div>
			</div>
		);
	}

	if (state.kind === "login") {
		return (
			<div className="min-h-screen bg-background flex items-center justify-center p-6 relative overflow-auto">
        <div className="portal-grid fixed inset-0 opacity-10" />
        {/* Decorative lusters */}
        <div className="fixed top-[-10%] left-[-10%] w-[40%] h-[40%] bg-primary/10 rounded-full blur-[120px]" />
        
				<div className="w-full max-w-md bg-card p-10 lg:p-12 rounded-[2.5rem] shadow-heavy border border-border/50 relative z-10 space-y-10">
					<div className="space-y-3 text-center">
            <ChalkLogo className="justify-center mb-6 scale-110" />
						<h1 className="text-3xl font-black tracking-tight text-foreground">Sign in to Chalk</h1>
						<p className="text-muted-foreground font-medium">
							Authorized access only for edge records.
						</p>
					</div>

					<div className="space-y-6">
            <div className="space-y-2">
              <label
                htmlFor="dashboard-email"
                className="text-[11px] font-black uppercase tracking-widest text-muted-foreground ml-1"
              >
                Email address
              </label>
              <input
                id="dashboard-email"
                name="email"
                type="email"
                inputMode="email"
                autoComplete="email"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="w-full rounded-2xl border border-border bg-secondary/30 px-6 py-4 text-base font-bold transition-all focus:ring-8 focus:ring-primary/5 focus:border-primary outline-none placeholder:text-muted-foreground/30"
                placeholder="name@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && email.trim() && sendLink()}
              />
            </div>
            <Button 
              onClick={sendLink} 
              size="lg" 
              disabled={!email.trim()}
              className="w-full h-14 rounded-2xl font-black text-sm uppercase tracking-widest shadow-xl shadow-primary/20 hover:shadow-2xl transition-all"
            >
              Get Sign-in Link
            </Button>
            
            {emailSent && (
              <div className="p-4 rounded-2xl bg-primary/5 border border-primary/10 flex items-center gap-3 animate-in fade-in zoom-in-95">
                <HugeiconsIcon icon={InformationCircleIcon} size={20} className="text-primary shrink-0" />
                <p className="text-xs text-primary font-bold">{emailSent}</p>
              </div>
            )}
					</div>

          <div className="pt-6 border-t border-border/50 text-center">
            <p className="text-[10px] font-black text-muted-foreground uppercase tracking-widest opacity-50">
              Ephemeral Security Protocol v1.0
            </p>
          </div>
				</div>
			</div>
		);
	}

	return (
		<div className="flex flex-col h-screen bg-background overflow-hidden relative selection:bg-primary/20">
      <Toaster position="top-right" theme={theme} />
      
      {/* Background Canvas Layer */}
      <div className="absolute inset-0 portal-grid opacity-10 pointer-events-none" />
      
      {/* HUD: Top Bar */}
      <header className="relative z-50 flex h-20 items-center justify-between px-10 border-b border-white/5 bg-background/50 backdrop-blur-xl">
        <div className="flex items-center gap-8">
          <Link to="/" className="hover:scale-105 transition-transform">
            <ChalkLogo className="scale-90" />
          </Link>
          <div className="h-4 w-px bg-white/10" />
          <div className="flex items-center gap-6">
            <div className="relative group">
              <HugeiconsIcon icon={Search01Icon} size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground group-focus-within:text-primary transition-colors" />
              <input 
                id="dashboard-search"
                name="dashboard-search"
                type="text" 
                autoComplete="off"
                spellCheck={false}
                placeholder="FIND_NODE" 
                className="h-10 w-64 rounded-full border border-white/5 bg-white/5 pl-11 pr-4 text-[10px] font-black uppercase tracking-widest focus:bg-white/10 outline-none transition-all"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>
        </div>
        
        <div className="flex items-center gap-6">
          <button onClick={toggleTheme} className="p-2 text-muted-foreground hover:text-foreground transition-all">
            <HugeiconsIcon icon={theme === "dark" ? Sun01Icon : Moon02Icon} size={20} />
          </button>
          <Link to="/" className="h-10 px-6 rounded-full bg-primary text-[10px] font-black uppercase tracking-widest shadow-xl glow-node flex items-center gap-2">
            <HugeiconsIcon icon={Video01Icon} size={14} />
            Initialize Room
          </Link>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden relative">
        {/* HUD: Sidebar Stats */}
        <aside className="w-80 border-r border-white/5 bg-background/30 backdrop-blur-2xl p-8 space-y-12 overflow-y-auto z-40 shadow-2xl">
          <div className="space-y-8">
            <h2 className="text-[10px] font-black uppercase tracking-[0.4em] text-primary">System_Overview</h2>
            {stats && (
              <div className="grid gap-6">
                {[
                  { label: "Active_Nodes", val: stats.totalMeetings, icon: Video01Icon },
                  { label: "Intelligence", val: stats.totalActionItems, icon: CheckmarkCircle01Icon },
                  { label: "Data_Volume", val: formatBytes(stats.totalSize), icon: Database01Icon }
                ].map((s, i) => (
                  <div key={i} className="glass-hud p-6 rounded-3xl space-y-2 group hover:scale-[1.02] transition-all">
                    <div className="flex items-center justify-between opacity-50">
                      <span className="text-[9px] font-black uppercase tracking-widest">{s.label}</span>
                      <HugeiconsIcon icon={s.icon} size={16} className="group-hover:text-primary transition-colors" />
                    </div>
                    <div className="text-3xl font-black tracking-tight tabular-nums">{s.val}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-6 pt-12 border-t border-white/5">
            <h2 className="text-[10px] font-black uppercase tracking-[0.4em] text-muted-foreground opacity-50">Protocols</h2>
            <nav className="grid gap-4">
              <a href="/docs" className="text-[10px] font-black uppercase tracking-widest hover:text-primary transition-colors flex items-center gap-3 group">
                <div className="w-1.5 h-1.5 rounded-full bg-primary group-hover:animate-ping" /> Documentation
              </a>
              <a href="#" className="text-[10px] font-black uppercase tracking-widest hover:text-primary transition-colors flex items-center gap-3 opacity-50">
                <div className="w-1.5 h-1.5 rounded-full bg-white/20" /> API Ledger
              </a>
            </nav>
          </div>
        </aside>

        {/* Main Canvas: Spatial Node Map */}
        <main ref={mainRef} className="flex-1 relative overflow-auto bg-black/20 canvas-pan scrollbar-hide">
          <div className="min-w-[2000px] min-h-[2000px] relative p-40">
            {/* Ambient Heatmap Layer */}
            <div className="absolute inset-0 pointer-events-none opacity-20 dark:opacity-10">
              <div className="absolute top-[400px] left-[400px] w-[600px] h-[600px] bg-primary/20 rounded-full blur-[150px] animate-pulse" />
              <div className="absolute top-[600px] left-[800px] w-[400px] h-[400px] bg-blue-500/10 rounded-full blur-[120px]" />
            </div>

            {/* Dynamic Connections (SVG Lines) */}
            <svg className="absolute inset-0 w-full h-full pointer-events-none overflow-visible">
              <defs>
                <linearGradient id="lineGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="var(--color-primary)" stopOpacity="0.3" />
                  <stop offset="100%" stopColor="var(--color-primary)" stopOpacity="0" />
                </linearGradient>
              </defs>
              {state.kind === 'ready' && state.data.meetings.slice(0, 20).map((_, i) => {
                const angle = i * (360 / Math.min(state.data.meetings.length, 20)) * (Math.PI / 180);
                const dist = 350 + (i % 3) * 100;
                return (
                  <line 
                    key={i}
                    x1="500" y1="500"
                    x2={500 + Math.cos(angle) * dist}
                    y2={500 + Math.sin(angle) * dist}
                    stroke="url(#lineGrad)"
                    strokeWidth="1"
                    strokeDasharray="4 4"
                    className="animate-[dash_20s_linear_infinite]"
                  />
                );
              })}
            </svg>

            {/* Central Node: The Core */}
            <div className="absolute top-[500px] left-[500px] -translate-x-1/2 -translate-y-1/2 z-20">
              <div className="w-32 h-32 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center backdrop-blur-md">
                <div className="w-24 h-24 rounded-full bg-primary/20 border-4 border-primary flex items-center justify-center glow-node animate-pulse shadow-[0_0_50px_rgba(27,182,166,0.4)]">
                  <ChalkLogo showText={false} className="scale-150" />
                </div>
              </div>
            </div>

            {/* Meeting Nodes */}
            {state.kind === 'ready' && state.data.meetings.map((m, i) => {
              const angle = i * (360 / Math.min(state.data.meetings.length, 30)) * (Math.PI / 180);
              const dist = 350 + (i % 3) * 100;
              const x = 500 + Math.cos(angle) * dist;
              const y = 500 + Math.sin(angle) * dist;
              const isSelected = selectedMeetingId === m.id;

              return (
                <button
                  key={m.id}
                  onClick={() => setSelectedMeetingId(m.id)}
                  className={cn(
                    "absolute -translate-x-1/2 -translate-y-1/2 z-30 transition-all duration-700 group",
                    isSelected ? "scale-150 z-40" : "hover:scale-110"
                  )}
                  style={{ left: x, top: y }}
                >
                  <div className={cn(
                    "w-16 h-16 rounded-[2rem] glass-hud flex items-center justify-center transition-all duration-500 relative",
                    isSelected ? "border-primary bg-primary/30 glow-node scale-110" : "group-hover:border-primary/50"
                  )}>
                    {/* Activity Indicator */}
                    {m.status === 'ready' && (
                      <div className="absolute -top-1 -right-1 w-4 h-4 bg-green-500 rounded-full border-4 border-background animate-pulse shadow-lg" />
                    )}
                    <HugeiconsIcon
                      icon={Video01Icon}
                      size={24}
                      className={cn(isSelected ? "text-white" : "text-muted-foreground group-hover:text-primary transition-colors")}
                    />
                  </div>
                  <div className={cn(
                    "absolute top-full mt-6 left-1/2 -translate-x-1/2 whitespace-nowrap px-5 py-2 rounded-full glass-hud text-[10px] font-black uppercase tracking-widest transition-all",
                    isSelected ? "opacity-100 translate-y-0 scale-75" : "opacity-0 translate-y-2 group-hover:opacity-100 group-hover:translate-y-0 scale-75"
                  )}>
                    {m.room_name || `NODE_${m.room_id.slice(0, 6)}`}
                  </div>
                </button>
              );
            })}
          </div>
        </main>

        {/* Floating Intel HUD (Right Side) */}
        {selectedMeeting && readyState && (
          <div className="absolute right-10 top-32 w-[450px] max-h-[75vh] glass-hud rounded-[3.5rem] p-12 z-50 overflow-y-auto animate-in slide-in-from-right-20 fade-in duration-700 shadow-[0_0_120px_rgba(0,0,0,0.6)] border-white/20">
            <button onClick={() => setSelectedMeetingId(null)} className="absolute top-10 right-10 p-2 rounded-full hover:bg-white/10 transition-all text-muted-foreground hover:text-foreground">
              <HugeiconsIcon icon={ArrowRight01Icon} size={24} className="rotate-180" />
            </button>
            
            <div className="space-y-12">
              <div className="space-y-6">
                <Badge className={cn(
                  "rounded-full px-4 py-1 text-[10px] font-black uppercase tracking-[0.2em] border shadow-sm",
                  selectedMeeting.status === 'ready' ? "bg-primary/20 text-primary border-primary/30" : "bg-white/5 text-muted-foreground border-white/10"
                )}>{selectedMeeting.status}</Badge>
                <h3 className="text-4xl font-black tracking-tighter uppercase italic leading-none">{selectedMeeting.room_name || 'UNNAMED_SESSION'}</h3>
                <div className="flex gap-8 text-[11px] font-black text-muted-foreground uppercase tracking-widest opacity-60">
                  <span className="flex items-center gap-2.5"><HugeiconsIcon icon={Calendar01Icon} size={14} className="text-primary" /> {new Date(selectedMeeting.created_at).toLocaleDateString()}</span>
                  <span className="flex items-center gap-2.5"><HugeiconsIcon icon={Clock01Icon} size={14} className="text-primary" /> {formatDuration(selectedMeeting.duration_seconds || 0)}</span>
                </div>
              </div>

              <div className="space-y-6 pt-10 border-t border-white/5">
                <div className="text-[10px] font-black text-primary uppercase tracking-[0.5em] flex items-center gap-3">
                  <HugeiconsIcon icon={File02Icon} size={16} /> Intel_Summary
                </div>
                <p className="text-xl font-bold text-foreground/90 leading-relaxed italic">
                  "{selectedMeeting.transcript_summary || 'Analysis in progress for this session node.'}"
                </p>
              </div>

              {selectedMeeting.transcript_action_items && selectedMeeting.transcript_action_items.length > 0 && (
                <div className="space-y-8 pt-10 border-t border-white/5">
                  <div className="text-[10px] font-black text-primary uppercase tracking-[0.5em] flex items-center gap-3">
                    <HugeiconsIcon icon={CheckmarkCircle01Icon} size={16} /> Action_Ledger
                  </div>
                  <div className="grid gap-4">
                    {selectedMeeting.transcript_action_items.map((item, idx) => (
                      <div key={idx} className="p-5 rounded-2xl bg-white/[0.03] border border-white/5 text-sm font-bold text-foreground/80 flex items-start gap-4 hover:bg-white/[0.05] transition-all">
                        <div className="w-5 h-5 rounded-lg bg-primary/20 text-primary flex items-center justify-center text-[10px] font-black shrink-0 mt-0.5">{idx + 1}</div>
                        <span className="uppercase tracking-tight leading-tight">{item}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="pt-12 flex gap-5">
                <Button
                  size="lg"
                  className="flex-1 h-16 rounded-full font-black uppercase tracking-widest text-[11px] glow-node shadow-2xl"
                  disabled={selectedMeeting.status !== "ready"}
                  onClick={() =>
                    downloadRecording(selectedMeeting.id, readyState.token)
                      .then(() => toast.success("Download ready"))
                      .catch((error) => toast.error(error.message))
                  }
                >
                  Download Session
                </Button>
                <Button
                  variant="secondary"
                  size="lg"
                  className="flex-1 h-16 rounded-full font-black uppercase tracking-widest text-[11px] glass-hud"
                  disabled={selectedMeeting.status !== "ready"}
                  onClick={() =>
                    createShareLink(selectedMeeting.id, readyState.token)
                      .then(() => toast.success("Link copied"))
                      .catch((error) => toast.error(error.message))
                  }
                >
                  Access Link
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
		</div>
	);
}
