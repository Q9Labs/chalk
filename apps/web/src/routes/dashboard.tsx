import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import z from "zod";
import { ConferenceClient, type RoomResource } from "@q9labs/chalk-core";
import { fetchInternalAccessToken, getApiUrl, startMagicLink, createWebTokenProvider } from "../lib/internalAuth";
import { VideoPlayer } from "../components/VideoPlayer";
import { cn } from "../lib/utils";
import { HugeiconsIcon } from "@hugeicons/react";
import { Video01Icon, Download01Icon, Share01Icon, Calendar01Icon, Clock01Icon, File02Icon, Search01Icon, Database01Icon, AlertCircleIcon, CheckmarkCircle01Icon, InformationCircleIcon, Sun01Icon, Moon02Icon, Home01Icon, Archive01Icon, Settings03Icon } from "@hugeicons/core-free-icons";
import { useTheme } from "../context/theme";
import { toast, Toaster } from "sonner";
import { ScheduledClassesPanel } from "../features/classes/components/ScheduledClassesPanel";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@q9labs/chalk-ui";
import { ChalkLogo } from "../components/ChalkLogo";
import { SettingsModal } from "../components/SettingsModal";
import { Logout01Icon } from "@hugeicons/core-free-icons";

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

function getAvatarGradient(email: string) {
  const hash = email.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const gradients = ["from-blue-500 to-cyan-400", "from-purple-500 to-pink-400", "from-emerald-500 to-teal-400", "from-orange-500 to-yellow-400", "from-indigo-500 to-purple-400"];
  return gradients[hash % gradients.length];
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
  const [state, setState] = useState<{ kind: "loading" } | { kind: "login" } | { kind: "ready"; data: MeetingsResponse; token: string } | { kind: "error"; message: string }>({ kind: "loading" });

  const [email, setEmail] = useState("");
  const [emailSent, setEmailSent] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [classRooms, setClassRooms] = useState<RoomResource[]>([]);
  const [classesLoading, setClassesLoading] = useState(false);
  const [classesError, setClassesError] = useState<string | null>(null);
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const [isFetchingVideo, setIsFetchingVideo] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const userEmail = useMemo(() => {
    // Try to get email from state kind ready
    if (state.kind === "ready") return "hasan@q9labs.ai";
    return "guest@chalk.ai";
  }, [state]);

  const avatarGradient = useMemo(() => getAvatarGradient(userEmail), [userEmail]);

  const handleLogout = useCallback(() => {
    // Simple logout: clear state and reload
    window.localStorage.removeItem("chalk_join_context_v1");
    window.location.href = "/";
  }, []);

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
        if (!res.ok) throw new Error(`Connection failed (${res.status})`);
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
      setEmailSent("Sign-in link sent. Please check your inbox.");
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
    return state.data.meetings.find((m) => m.id === (selectedId || state.data.meetings[0]?.id));
  }, [state, selectedId]);

  // Fetch presigned URL when a meeting is selected
  useEffect(() => {
    if (!selectedMeeting || state.kind !== "ready") {
      setRecordingUrl(null);
      setVideoError(null);
      return;
    }

    let cancelled = false;
    (async () => {
      setIsFetchingVideo(true);
      setVideoError(null);
      setRecordingUrl(null);

      try {
        const res = await fetch(`${apiUrl}/api/v1/recordings/${selectedMeeting.id}/download`, {
          headers: { Authorization: `Bearer ${state.token}` },
        });
        const data = (await res.json()) as { message?: string; download_url?: string };
        if (cancelled) return;

        if (res.status === 410) throw new Error(data?.message || "Recording has expired");
        if (!res.ok) throw new Error(`Fetch failed (${res.status})`);

        const url = data?.download_url;
        if (typeof url !== "string" || !url) throw new Error(data?.message || "Recording is not ready yet");

        setRecordingUrl(url);
      } catch (err) {
        if (!cancelled) {
          setVideoError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setIsFetchingVideo(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedMeeting, state, apiUrl]);

  if (state.kind === "loading") {
    return (
      <div className="font-app h-screen bg-background flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          <p className="text-sm font-medium text-muted-foreground animate-pulse">Initializing Dashboard...</p>
        </div>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="font-app h-screen bg-background flex items-center justify-center p-6 text-center">
        <Card className="max-w-md w-full border-border shadow-lg">
          <CardHeader>
            <div className="mx-auto w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center text-destructive mb-2">
              <HugeiconsIcon icon={AlertCircleIcon} size={24} />
            </div>
            <CardTitle>Connection Error</CardTitle>
            <CardDescription>{state.message}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => window.location.reload()} className="w-full font-bold">
              Retry Connection
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (state.kind === "login") {
    return (
      <div className="font-app min-h-screen flex items-center justify-center p-6 relative overflow-hidden bg-background selection:bg-primary/20">
        {/* Dynamic Luminescent Mesh Background */}
        <div className="absolute inset-0 z-0">
          <div className="absolute top-1/4 left-1/4 w-[40vw] h-[40vw] max-w-[600px] max-h-[600px] bg-primary/20 rounded-full blur-[100px] mix-blend-screen animate-pulse duration-[8000ms]" />
          <div className="absolute bottom-1/4 right-1/4 w-[35vw] h-[35vw] max-w-[500px] max-h-[500px] bg-blue-500/10 rounded-full blur-[120px] mix-blend-screen animate-pulse duration-[10000ms] delay-1000" />
        </div>

        {/* Glassmorphism Portal Card */}
        <div className="w-full max-w-[420px] relative z-10">
          <div className="absolute inset-0 bg-gradient-to-b from-white/10 to-transparent rounded-[2rem] border border-white/10 dark:from-white/5 dark:border-white/5 pointer-events-none" />

          <Card className="bg-background/40 dark:bg-black/40 backdrop-blur-2xl border-white/20 dark:border-white/10 shadow-2xl rounded-[2rem] overflow-hidden">
            <CardHeader className="text-center pb-8 pt-12">
              <div className="mx-auto w-16 h-16 rounded-2xl bg-gradient-to-br from-primary/20 to-primary/5 border border-primary/20 flex items-center justify-center mb-6 shadow-inner">
                <ChalkLogo className="scale-110" />
              </div>
              <CardTitle className="text-3xl font-black tracking-tight mb-2">Welcome Back</CardTitle>
              <CardDescription className="text-base text-foreground/60">Enter your email to securely access your workspace.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6 px-10 pb-12">
              <div className="space-y-3">
                <label className="text-xs font-bold uppercase tracking-widest text-foreground/50 ml-1">Work Email</label>
                <div className="relative group">
                  <Input
                    type="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && email.trim() && sendLink()}
                    className="h-14 bg-background/50 border-white/20 dark:border-white/10 rounded-xl pl-4 pr-12 focus:ring-4 focus:ring-primary/20 transition-all font-medium text-lg placeholder:text-muted-foreground/50 shadow-inner"
                    autoFocus
                  />
                  <div className="absolute right-4 top-1/2 -translate-y-1/2 flex items-center pointer-events-none">
                    <div className="w-1.5 h-1.5 rounded-full bg-primary/40 group-focus-within:bg-primary group-focus-within:animate-pulse transition-colors" />
                  </div>
                </div>
              </div>

              <Button onClick={sendLink} disabled={!email.trim()} className="w-full h-14 rounded-xl font-bold text-base shadow-lg shadow-primary/25 hover:shadow-xl hover:shadow-primary/30 transition-all active:scale-[0.98] mt-2 relative overflow-hidden group">
                <div className="absolute inset-0 bg-white/20 translate-y-full group-hover:translate-y-0 transition-transform duration-300 ease-out" />
                <span className="relative">Send Magic Link</span>
              </Button>

              {emailSent && (
                <div className="p-4 rounded-xl bg-primary/10 border border-primary/20 flex gap-3 animate-in fade-in slide-in-from-bottom-2 duration-500">
                  <HugeiconsIcon icon={InformationCircleIcon} size={20} className="text-primary shrink-0 mt-0.5" />
                  <p className="text-sm font-semibold text-primary/90 leading-snug">{emailSent}</p>
                </div>
              )}
            </CardContent>

            {/* Edge Security Footer */}
            <div className="bg-gradient-to-b from-transparent to-background/50 p-6 text-center border-t border-border/20 backdrop-blur-sm">
              <p className="text-[10px] font-black text-muted-foreground/60 uppercase tracking-[0.2em] flex items-center justify-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]" />
                Protected by Edge Security
              </p>
            </div>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="font-app min-h-screen bg-muted/40 selection:bg-primary/20 flex flex-col">
      <Toaster position="top-right" theme={theme === "nord" ? "dark" : theme} />

      {/* Top Navigation */}
      <header className="sticky top-0 z-50 h-16 w-full border-b border-border bg-background/80 backdrop-blur-xl flex items-center justify-between px-6">
        <div className="flex items-center gap-6">
          <Link to="/" className="hover:opacity-80 transition-opacity focus-visible:ring-2 focus-visible:ring-primary rounded-sm outline-none">
            <ChalkLogo className="scale-90 origin-left" />
          </Link>
          <nav className="hidden md:flex items-center gap-1">
            {[
              { icon: Home01Icon, label: "Dashboard", active: true },
              { icon: Archive01Icon, label: "Library" },
              { icon: Settings03Icon, label: "Settings" },
            ].map((item, i) => (
              <button key={i} className={cn("flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-semibold transition-all focus-visible:ring-2 focus-visible:ring-primary outline-none", item.active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>
                <HugeiconsIcon icon={item.icon} size={16} aria-hidden="true" />
                {item.label}
              </button>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-4 flex-1 max-w-md mx-6">
          <div className="relative w-full group">
            <HugeiconsIcon icon={Search01Icon} size={16} aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground group-focus-within:text-primary transition-colors" />
            <Input placeholder="Find a session…" className="h-9 border-border bg-muted/30 pl-10 focus-visible:ring-primary/30" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search sessions" />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Link to="/">
            <Button size="sm" className="font-bold text-xs shadow-md shadow-primary/10 gap-2 h-9 px-4">
              <HugeiconsIcon icon={Video01Icon} size={16} aria-hidden="true" /> Create Room
            </Button>
          </Link>
          <div className="w-px h-6 bg-border mx-1" />
          <button onClick={toggleTheme} className="p-2 rounded-full hover:bg-muted text-muted-foreground transition-colors focus-visible:ring-2 focus-visible:ring-primary outline-none" aria-label="Toggle theme">
            <HugeiconsIcon icon={theme === "dark" || theme === "nord" ? Sun01Icon : Moon02Icon} size={18} aria-hidden="true" />
          </button>

          <DropdownMenu>
            <DropdownMenuTrigger>
              <button
                className={cn("w-9 h-9 rounded-full flex items-center justify-center border border-border/50 cursor-pointer hover:ring-2 ring-primary/30 transition-all ml-1 overflow-hidden bg-gradient-to-br shadow-inner outline-none focus-visible:ring-2 focus-visible:ring-primary", avatarGradient)}
              >
                <span className="text-white font-black text-xs tracking-tighter uppercase">{userEmail.substring(0, 2)}</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56 mt-2">
              <DropdownMenuGroup>
                <DropdownMenuLabel className="flex flex-col py-2 px-3">
                  <span className="text-xs font-black uppercase tracking-widest text-muted-foreground mb-1">Signed in as</span>
                  <span className="text-sm font-bold truncate">{userEmail}</span>
                </DropdownMenuLabel>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setIsSettingsOpen(true)} className="py-2.5 font-semibold gap-3 cursor-pointer">
                <HugeiconsIcon icon={Settings03Icon} size={16} />
                Settings
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={handleLogout} className="py-2.5 font-bold gap-3 cursor-pointer text-destructive focus:text-destructive">
                <HugeiconsIcon icon={Logout01Icon} size={16} />
                Sign Out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />

      {/* Main Content Area */}
      <div className="flex-1 flex max-w-[1600px] w-full mx-auto relative overflow-hidden">
        {/* Left Column: Lists */}
        <aside className="w-full md:w-[400px] flex-shrink-0 flex flex-col border-r border-border bg-background/50 h-[calc(100vh-4rem)] overflow-y-auto scrollbar-hide">
          <div className="p-6 space-y-8">
            <ScheduledClassesPanel client={sdkClient} rooms={classRooms} isLoading={classesLoading} error={classesError} onRefresh={refreshClasses} />

            <div className="space-y-4">
              <div className="flex items-center justify-between px-1">
                <h3 className="text-sm font-bold text-foreground">Recent Sessions</h3>
                <Badge variant="secondary" className="font-bold px-2 py-0 h-5 tabular-nums pointer-events-none">
                  {state.data?.meetings?.length || 0}
                </Badge>
              </div>
              <div className="space-y-2">
                {(state.data?.meetings || [])
                  .filter((m) => (m.room_name || "").toLowerCase().includes(search.toLowerCase()))
                  .map((m) => {
                    const isActive = selectedId === m.id;
                    return (
                      <button
                        key={m.id}
                        onClick={() => setSelectedId(m.id)}
                        className={cn("w-full text-left p-4 rounded-xl transition-all border group min-w-0 outline-none focus-visible:ring-2 focus-visible:ring-primary", isActive ? "bg-primary/5 border-primary/30 shadow-sm" : "border-transparent hover:bg-muted/50 hover:border-border/80")}
                      >
                        <div className="flex flex-col gap-2.5 min-w-0">
                          <div className="flex items-start justify-between gap-3">
                            <h4 className={cn("font-bold text-[13px] leading-tight truncate flex-1", isActive ? "text-primary dark:text-primary-foreground" : "text-foreground/90")}>{m.room_name || `Untitled Session ${m.room_id.slice(0, 4)}`}</h4>
                            <div className={cn("w-1.5 h-1.5 rounded-full shrink-0 mt-1.5", m.status === "ready" ? "bg-primary" : "bg-muted-foreground/30")} />
                          </div>
                          <div className="flex items-center gap-4 text-[11px] font-semibold text-muted-foreground tabular-nums">
                            <span className="flex items-center gap-1.5 min-w-0 truncate">
                              <HugeiconsIcon icon={Calendar01Icon} size={12} aria-hidden="true" /> {new Date(m.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                            </span>
                            <span className="flex items-center gap-1.5 shrink-0">
                              <HugeiconsIcon icon={Clock01Icon} size={12} aria-hidden="true" /> {formatDuration(m.duration_seconds || 0)}
                            </span>
                          </div>
                        </div>
                      </button>
                    );
                  })}
              </div>
            </div>
          </div>
        </aside>

        {/* Right Column: Intelligence Display (Bento Box) */}
        <main className="flex-1 min-w-0 bg-muted/10 h-[calc(100vh-4rem)] overflow-y-auto outline-none" tabIndex={-1}>
          {selectedMeeting ? (
            <div className="p-8 lg:p-12 max-w-5xl mx-auto animate-in fade-in zoom-in-[0.98] duration-300">
              {/* Header Container */}
              <div className="mb-10 space-y-6">
                <div className="flex items-center justify-between flex-wrap gap-4">
                  <div className="flex items-center gap-3">
                    <Badge variant={selectedMeeting.status === "ready" ? "default" : "secondary"} className="rounded-md font-bold px-2 py-0.5">
                      {selectedMeeting.status === "ready" ? "READY" : "PROCESSING"}
                    </Badge>
                    <span className="text-xs font-semibold text-muted-foreground tabular-nums">ID: {selectedMeeting.id}</span>
                  </div>
                  <div className="flex items-center gap-2.5">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={selectedMeeting.status !== "ready"}
                      onClick={() =>
                        createShareLink(selectedMeeting.id, state.token)
                          .then(() => toast.success("Link copied to clipboard"))
                          .catch((e) => toast.error(e.message))
                      }
                      className="font-bold h-9 bg-background shadow-sm hover:border-primary/50 transition-colors"
                    >
                      <HugeiconsIcon icon={Share01Icon} size={16} className="mr-2" aria-hidden="true" /> Share
                    </Button>
                    <Button
                      size="sm"
                      disabled={selectedMeeting.status !== "ready"}
                      onClick={() =>
                        downloadRecording(selectedMeeting.id, state.token)
                          .then(() => toast.success("Download started"))
                          .catch((e) => toast.error(e.message))
                      }
                      className="font-bold h-9 shadow-sm shadow-primary/20"
                    >
                      <HugeiconsIcon icon={Download01Icon} size={16} className="mr-2" aria-hidden="true" /> Download
                    </Button>
                  </div>
                </div>

                <h1 className="text-3xl lg:text-4xl font-extrabold tracking-tight text-foreground text-balance">{selectedMeeting.room_name || "Untitled Meeting Session"}</h1>
              </div>

              {/* Bento Grid layout */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {/* Stats row - Bento boxes */}
                <div className="md:col-span-3 grid grid-cols-1 sm:grid-cols-3 gap-6">
                  {[
                    {
                      label: "Recorded On",
                      val: new Date(selectedMeeting.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }),
                      sub: new Date(selectedMeeting.created_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
                      icon: Calendar01Icon,
                    },
                    { label: "Total Length", val: formatDuration(selectedMeeting.duration_seconds || 0), sub: "Recorded session", icon: Clock01Icon },
                    { label: "Archive Size", val: formatBytes(selectedMeeting.size_bytes || 0), sub: "Cloud storage", icon: Database01Icon },
                  ].map((item, i) => (
                    <Card key={i} className="bg-background/60 backdrop-blur-sm border-border/60 shadow-sm hover:bg-background/80 transition-colors group">
                      <CardContent className="p-5 flex items-start gap-4">
                        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0 group-hover:scale-105 group-hover:bg-primary/20 transition-all">
                          <HugeiconsIcon icon={item.icon} size={20} className="text-primary" aria-hidden="true" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-[11px] font-bold text-muted-foreground uppercase tracking-widest leading-none mb-1.5">{item.label}</p>
                          <p className="text-lg font-bold text-foreground tabular-nums truncate">{item.val}</p>
                          <p className="text-[11px] text-muted-foreground font-medium mt-0.5 truncate">{item.sub}</p>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>

                {/* Video Player Box */}
                <div className="md:col-span-3">
                  <Card className="bg-background border-border shadow-sm overflow-hidden flex flex-col group">
                    {isFetchingVideo ? (
                      <div className="w-full aspect-video bg-muted/20 flex flex-col items-center justify-center border-b border-border/40">
                        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mb-4" />
                        <p className="text-sm font-semibold text-muted-foreground animate-pulse">Loading secure playback link…</p>
                      </div>
                    ) : videoError ? (
                      <div className="w-full aspect-video bg-muted/10 flex flex-col items-center justify-center p-6 text-center border-b border-border/40 text-muted-foreground">
                        <div className="w-12 h-12 rounded-full bg-secondary text-secondary-foreground flex items-center justify-center mb-3">
                          <HugeiconsIcon icon={Video01Icon} size={24} aria-hidden="true" />
                        </div>
                        <p className="text-[15px] font-bold">Video Unavailable</p>
                        <p className="text-sm opacity-80 mt-1">{videoError}</p>
                      </div>
                    ) : recordingUrl ? (
                      <div className="w-full aspect-video border-b border-border/40 bg-black">
                        <VideoPlayer url={recordingUrl} className="w-full h-full rounded-none border-0" />
                      </div>
                    ) : null}
                  </Card>
                </div>

                {/* Main Content Row - Bento Boxes */}
                <Card className="md:col-span-2 bg-background border-border shadow-sm flex flex-col hover:border-border/80 transition-colors">
                  <CardHeader className="pb-3 border-b border-border/40">
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                        <HugeiconsIcon icon={File02Icon} size={18} className="text-primary" aria-hidden="true" />
                      </div>
                      <CardTitle className="text-sm font-bold uppercase tracking-widest text-foreground/90">Meeting Summary</CardTitle>
                    </div>
                  </CardHeader>
                  <CardContent className="p-6 flex-1">
                    <p className="text-[15px] font-medium text-foreground/80 leading-relaxed text-pretty">
                      {selectedMeeting.transcript_summary ? (
                        selectedMeeting.transcript_summary
                      ) : (
                        <span className="italic text-muted-foreground flex items-center gap-2">
                          <div className="w-4 h-4 rounded-full border-2 border-primary/30 border-t-primary animate-spin shrink-0" />
                          Generating executive summary…
                        </span>
                      )}
                    </p>
                  </CardContent>
                </Card>

                <Card className="md:col-span-1 bg-background border-border shadow-sm flex flex-col hover:border-border/80 transition-colors">
                  <CardHeader className="pb-3 border-b border-border/40">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                          <HugeiconsIcon icon={CheckmarkCircle01Icon} size={18} className="text-primary" aria-hidden="true" />
                        </div>
                        <CardTitle className="text-sm font-bold uppercase tracking-widest text-foreground/90">Key Tasks</CardTitle>
                      </div>
                      {selectedMeeting.transcript_action_items && selectedMeeting.transcript_action_items.length > 0 && (
                        <Badge variant="secondary" className="px-1.5 tabular-nums pointer-events-none">
                          {selectedMeeting.transcript_action_items.length}
                        </Badge>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent className="p-0 flex-1 overflow-y-auto max-h-[400px] scrollbar-hide">
                    <div className="flex flex-col">
                      {selectedMeeting.transcript_action_items && selectedMeeting.transcript_action_items.length > 0 ? (
                        selectedMeeting.transcript_action_items.map((item, idx) => (
                          <div key={idx} className="p-4 border-b border-border/40 last:border-0 flex gap-4 hover:bg-muted/30 transition-colors group">
                            <span className="w-6 h-6 rounded-md bg-secondary text-secondary-foreground flex items-center justify-center text-[11px] font-bold shrink-0 shadow-sm group-hover:bg-primary group-hover:text-primary-foreground transition-colors tabular-nums">{idx + 1}</span>
                            <span className="text-[13px] font-medium text-foreground/90 leading-snug pt-0.5">{item}</span>
                          </div>
                        ))
                      ) : (
                        <div className="p-8 text-center flex flex-col items-center justify-center h-full opacity-60">
                          <HugeiconsIcon icon={CheckmarkCircle01Icon} size={32} className="text-muted-foreground mb-3" aria-hidden="true" />
                          <p className="text-xs font-semibold text-muted-foreground italic">No action items found.</p>
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>
          ) : (
            <div className="h-full flex items-center justify-center p-12 text-center">
              <div className="max-w-sm space-y-6 opacity-40">
                <div className="mx-auto w-24 h-24 rounded-3xl bg-background border border-border shadow-sm flex items-center justify-center">
                  <HugeiconsIcon icon={Video01Icon} size={48} className="text-muted-foreground" aria-hidden="true" />
                </div>
                <div className="space-y-2">
                  <h3 className="text-xl font-bold text-balance">Select a Session</h3>
                  <p className="text-sm font-medium text-pretty">Choose a meeting from your library to view intelligent summaries, key action items, and more.</p>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
