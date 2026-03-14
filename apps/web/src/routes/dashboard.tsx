import { createTokenProvider } from "@q9labs/chalk-core";
import { ChalkProvider, useChalk } from "@q9labs/chalk-react";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, Input } from "@q9labs/chalk-ui";
import { Archive01Icon, Calendar01Icon, CheckmarkCircle01Icon, Clock01Icon, Database01Icon, Download01Icon, File02Icon, Home01Icon, InformationCircleIcon, Logout01Icon, Moon02Icon, Search01Icon, Settings03Icon, Share01Icon, Sun01Icon, Video01Icon, AlertCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useTheme } from "../context/theme";
import { fetchInternalAccessToken, getApiUrl, logoutInternalSession, startGoogleOAuthSignIn } from "../lib/internalAuth";
import { useProfileAvatar } from "../lib/useProfileAvatar";
import { cn } from "../lib/utils";
import { ScheduledClassesPanel } from "../features/classes/components/ScheduledClassesPanel";
import { SettingsModal } from "../components/SettingsModal";
import { ChalkLoader } from "../components/ChalkLoader";
import { ChalkLogo } from "../components/ChalkLogo";
import { VideoPlayer } from "../components/VideoPlayer";
import { Loader2 } from "lucide-react";

export const Route = createFileRoute("/dashboard")({
  component: DashboardPage,
});

type Meeting = {
  id: string;
  room_id: string;
  room_name: string | null;
  status: "ready" | "processing" | "error";
  duration_seconds: number | null;
  size_bytes: number | null;
  created_at: string;
  transcript_summary: string | null;
  transcript_action_items: string[] | null;
};

type MeetingsResponse = {
  meetings: Meeting[];
};

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h > 0 ? h : null, m, s]
    .filter((v) => v !== null)
    .map((v) => String(v).padStart(2, "0"))
    .join(":");
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

async function createShareLink(meetingId: string, token: string) {
  const apiUrl = getApiUrl();
  const res = await fetch(`${apiUrl}/api/v1/internal/meetings/${meetingId}/share`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("failed to create share link");
  const { url } = await res.json();
  await navigator.clipboard.writeText(url);
}

async function downloadRecording(meetingId: string, token: string) {
  const apiUrl = getApiUrl();
  const res = await fetch(`${apiUrl}/api/v1/internal/meetings/${meetingId}/download`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("failed to get download link");
  const { url } = await res.json();
  window.open(url, "_blank");
}

function DashboardPage() {
  const apiUrl = getApiUrl();
  const [state, setState] = useState<{ kind: "loading" } | { kind: "login" } | { kind: "ready"; data: MeetingsResponse; token: string } | { kind: "error"; message: string }>({ kind: "loading" });
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const [isFetchingVideo, setIsFetchingVideo] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();

  useEffect(() => {
    fetchInternalAccessToken(apiUrl)
      .then(async (token) => {
        if (!token) {
          setState({ kind: "login" });
          return;
        }
        const res = await fetch(`${apiUrl}/api/v1/internal/meetings`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.status === 401) {
          setState({ kind: "login" });
          return;
        }
        const data = await res.json();
        setState({ kind: "ready", data, token });
        if (data.meetings?.length > 0) setSelectedId(data.meetings[0].id);
      })
      .catch((e) => setState({ kind: "error", message: e.message }));
  }, [apiUrl]);

  useEffect(() => {
    if (state.kind !== "ready" || !selectedId) return;
    setIsFetchingVideo(true);
    setVideoError(null);
    setRecordingUrl(null);

    fetch(`${apiUrl}/api/v1/internal/meetings/${selectedId}/playback`, {
      headers: { Authorization: `Bearer ${state.token}` },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error("playback unauthorized or expired");
        const { url } = await res.json();
        setRecordingUrl(url);
      })
      .catch((e) => setVideoError(e.message))
      .finally(() => setIsFetchingVideo(false));
  }, [apiUrl, selectedId, state]);

  const selectedMeeting = useMemo(() => {
    if (state.kind !== "ready") return null;
    return state.data.meetings.find((m) => m.id === selectedId);
  }, [state, selectedId]);

  const startGoogleSignIn = async () => {
    try {
      setIsSigningIn(true);
      await startGoogleOAuthSignIn(apiUrl);
      window.location.reload();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setIsSigningIn(false);
    }
  };

  const handleLogout = async () => {
    try {
      await logoutInternalSession(apiUrl);
    } catch (error: any) {
      toast.error(error?.message ?? "logout failed");
    } finally {
      window.location.reload();
    }
  };

  const userEmail = useMemo(() => {
    if (state.kind !== "ready") return "";
    try {
      const payload = JSON.parse(atob(state.token.split(".")[1]));
      return payload.email || "";
    } catch {
      return "";
    }
  }, [state]);

  const avatarProfile = useProfileAvatar(userEmail);

  // Mock for classes panel integration
  const sdkClient = useChalk();
  const [classRooms, setClassRooms] = useState([]);
  const [classesLoading, setClassesLoading] = useState(false);
  const [classesError, setClassesError] = useState<Error | null>(null);

  const refreshClasses = async () => {
    setClassesLoading(true);
    try {
      // Classes fetch logic would go here
    } catch (e: any) {
      setClassesError(e);
    } finally {
      setClassesLoading(false);
    }
  };

  if (state.kind === "loading") {
    return (
      <div className="font-app h-screen slate-canvas flex flex-col p-8 overflow-hidden">
        <header className="flex items-center justify-between mb-12 animate-in fade-in duration-700">
          <ChalkLogo className="opacity-50" />
          <div className="w-10 h-10 rounded-full sketch-loading" />
        </header>
        <div className="flex-1 grid grid-cols-1 md:grid-cols-4 gap-8">
          <div className="space-y-6">
            <div className="h-10 w-3/4 rounded-lg sketch-loading" />
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="h-24 rounded-2xl sketch-loading" style={{ animationDelay: `${i * 0.1}s` }} />
            ))}
          </div>
          <div className="md:col-span-3 space-y-8">
            <div className="h-[400px] rounded-3xl sketch-loading opacity-40" />
            <div className="grid grid-cols-3 gap-8">
              <div className="h-32 rounded-2xl sketch-loading opacity-30" />
              <div className="h-32 rounded-2xl sketch-loading opacity-30" />
              <div className="h-32 rounded-2xl sketch-loading opacity-30" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="font-app h-screen slate-canvas flex items-center justify-center p-6 text-center">
        <Card className="max-w-md w-full bg-black/40 border-destructive/20 shadow-2xl backdrop-blur-xl rounded-3xl overflow-hidden">
          <CardHeader className="pt-10">
            <div className="mx-auto w-16 h-16 rounded-2xl bg-destructive/10 border border-destructive/20 flex items-center justify-center text-destructive mb-4 shadow-inner">
              <HugeiconsIcon icon={AlertCircleIcon} size={32} />
            </div>
            <CardTitle className="text-2xl font-black tracking-tight text-white">Connection Error</CardTitle>
            <CardDescription className="text-white/40 font-medium px-4">{state.message}</CardDescription>
          </CardHeader>
          <CardContent className="pb-10 px-8">
            <Button onClick={() => window.location.reload()} className="w-full h-12 rounded-xl font-bold bg-destructive text-white hover:bg-destructive/90 transition-all">
              Retry Connection
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (state.kind === "login") {
    return (
      <div className="font-app min-h-screen flex items-center justify-center p-6 relative overflow-hidden bg-[#0A0A0B] selection:bg-primary/30">
        {/* The Infinite Canvas - Dot Grid Texture */}
        <div className="absolute inset-0 z-0 opacity-[0.15]" 
          style={{ 
            backgroundImage: `radial-gradient(circle at 1px 1px, rgba(255,255,255,0.15) 1px, transparent 0)`,
            backgroundSize: '32px 32px' 
          }} 
        />
        
        {/* Subtle Slate Depth */}
        <div className="absolute inset-0 z-0">
          <div className="absolute top-0 left-0 w-full h-full bg-gradient-to-br from-primary/5 via-transparent to-transparent pointer-events-none" />
          <div className="absolute bottom-0 right-0 w-full h-full bg-gradient-to-tl from-blue-500/5 via-transparent to-transparent pointer-events-none" />
        </div>

        {/* The Portal Card */}
        <div className="w-full max-w-[440px] relative z-10 animate-in fade-in slide-in-from-bottom-8 duration-1000 ease-out">
          <Card className="bg-black/40 backdrop-blur-3xl border-white/[0.08] shadow-[0_32px_64px_-12px_rgba(0,0,0,0.8)] rounded-[2.5rem] overflow-hidden">
            <CardHeader className="text-center pb-6 pt-14 px-10">
              <div className="mx-auto mb-10 relative group">
                {/* Hero Loader */}
                <div className="absolute inset-0 bg-primary/20 blur-3xl rounded-full scale-150 opacity-0 group-hover:opacity-100 transition-opacity duration-1000" />
                <ChalkLoader size={88} className="relative z-10" />
              </div>
              
              <div className="space-y-2">
                <CardTitle className="text-4xl font-black tracking-tight text-white">
                  Chalk <span className="text-primary/80">Portal</span>
                </CardTitle>
                <CardDescription className="text-sm font-medium text-white/40 tracking-wide uppercase px-4">
                  Secure access to your creative workspace
                </CardDescription>
              </div>
            </CardHeader>

            <CardContent className="space-y-8 px-10 pb-16">
              <div className="space-y-4">
                <Button
                  onClick={startGoogleSignIn}
                  disabled={isSigningIn}
                  className="w-full h-16 rounded-2xl font-black text-lg tracking-tight bg-white text-black hover:bg-white/90 active:scale-[0.98] transition-all shadow-2xl relative group overflow-hidden"
                >
                  <span className="relative z-10 flex items-center justify-center gap-3">
                    {isSigningIn ? (
                      <>
                        <Loader2 className="size-5 animate-spin" aria-hidden="true" />
                        Connecting Google
                      </>
                    ) : (
                      <>
                        Continue with Google
                        <div className="w-1.5 h-1.5 rounded-full bg-black/20 animate-pulse" />
                      </>
                    )}
                  </span>
                </Button>

                <div className="p-5 rounded-2xl bg-primary/10 border border-primary/20 flex gap-4 animate-in zoom-in-95 fade-in duration-500">
                  <HugeiconsIcon icon={InformationCircleIcon} size={22} className="text-primary shrink-0" />
                  <p className="text-sm font-bold text-primary leading-snug">
                    Use your Chalk Google workspace account. Session cookies stay on this device until you sign out.
                  </p>
                </div>
              </div>
            </CardContent>

            {/* Tactical Footer */}
            <div className="px-10 py-6 bg-white/[0.02] border-t border-white/[0.05] flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.4)] animate-pulse" />
                <span className="text-[10px] font-black text-white/30 uppercase tracking-[0.2em]">Edge Secure</span>
              </div>
              <div className="flex gap-4">
                <div className="w-px h-3 bg-white/10" />
                <span className="text-[10px] font-black text-white/30 uppercase tracking-[0.2em]">v{__WEB_APP_VERSION__}</span>
              </div>
            </div>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="font-app min-h-screen slate-canvas selection:bg-primary/20 flex flex-col text-white">
      <NotificationStack notifications={[]} onDismiss={() => {}} />

      {/* Textured Header */}
      <header className="sticky top-0 z-50 h-16 w-full border-b border-white/[0.05] bg-black/40 backdrop-blur-3xl flex items-center justify-between px-6">
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
              <button key={i} className={cn("flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold transition-all focus-visible:ring-2 focus-visible:ring-primary outline-none", item.active ? "bg-primary/10 text-primary shadow-[inset_0_0_12px_rgba(27,182,166,0.1)]" : "text-white/40 hover:bg-white/[0.05] hover:text-white/80")}>
                <HugeiconsIcon icon={item.icon} size={16} aria-hidden="true" />
                {item.label}
              </button>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-4 flex-1 max-w-md mx-6">
          <div className="relative w-full group">
            <HugeiconsIcon icon={Search01Icon} size={16} aria-hidden="true" className="absolute left-4 top-1/2 -translate-y-1/2 text-white/20 group-focus-within:text-primary transition-colors" />
            <Input placeholder="Search your creative sessions…" className="h-10 border-white/[0.08] bg-black/40 pl-11 rounded-xl focus-visible:ring-primary/30 text-white placeholder:text-white/20" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search sessions" />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Link to="/">
            <Button size="sm" className="font-black text-[11px] uppercase tracking-wider shadow-lg shadow-primary/20 gap-2 h-10 px-5 rounded-xl transition-all hover:scale-105 active:scale-95">
              <HugeiconsIcon icon={Video01Icon} size={16} aria-hidden="true" /> Create Room
            </Button>
          </Link>
          <div className="w-px h-6 bg-white/[0.1] mx-1" />
          <button onClick={toggleTheme} className="p-2.5 rounded-full hover:bg-white/[0.05] text-white/40 hover:text-white transition-all focus-visible:ring-2 focus-visible:ring-primary outline-none" aria-label="Toggle theme">
            <HugeiconsIcon icon={theme === "dark" || theme === "nord" ? Sun01Icon : Moon02Icon} size={18} aria-hidden="true" />
          </button>

          <DropdownMenu>
            <DropdownMenuTrigger>
              <button
                className="w-10 h-10 rounded-full flex items-center justify-center border border-white/10 cursor-pointer hover:ring-4 ring-primary/20 transition-all ml-1 overflow-hidden shadow-2xl outline-none focus-visible:ring-2 focus-visible:ring-primary"
                style={{ backgroundImage: avatarProfile.backgroundImage }}
              >
                <span className="text-white font-black text-xs tracking-tighter uppercase">{avatarProfile.initials}</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60 mt-4 bg-black/90 backdrop-blur-2xl border-white/10 rounded-2xl shadow-3xl">
              <DropdownMenuGroup>
                <DropdownMenuLabel className="flex flex-col py-3 px-4">
                  <span className="text-[10px] font-black uppercase tracking-widest text-white/30 mb-1">Authenticated</span>
                  <span className="text-sm font-bold truncate text-white">{userEmail}</span>
                </DropdownMenuLabel>
              </DropdownMenuGroup>
              <DropdownMenuSeparator className="bg-white/5" />
              <DropdownMenuItem onSelect={() => setIsSettingsOpen(true)} className="py-3 font-semibold gap-3 cursor-pointer text-white/70 focus:text-white focus:bg-white/5 transition-colors">
                <HugeiconsIcon icon={Settings03Icon} size={16} />
                Portal Settings
              </DropdownMenuItem>
              <DropdownMenuSeparator className="bg-white/5" />
              <DropdownMenuItem onSelect={handleLogout} className="py-3 font-bold gap-3 cursor-pointer text-destructive focus:text-destructive focus:bg-destructive/10 transition-colors">
                <HugeiconsIcon icon={Logout01Icon} size={16} />
                Secure Logout
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />

      {/* Main Content Area */}
      <div className="flex-1 flex max-w-[1700px] w-full mx-auto relative overflow-hidden">
        {/* Left Column: Lists */}
        <aside className="w-full md:w-[440px] flex-shrink-0 flex flex-col border-r border-white/[0.05] bg-black/20 h-[calc(100vh-4rem)] overflow-y-auto scrollbar-hide">
          <div className="p-8 space-y-10">
            <ScheduledClassesPanel client={sdkClient} rooms={classRooms} isLoading={classesLoading} error={classesError} onRefresh={refreshClasses} />

            <div className="space-y-6">
              <div className="flex items-center justify-between px-2">
                <h3 className="text-xs font-black uppercase tracking-widest text-white/40">Recent Sessions</h3>
                <span className="font-mono text-[10px] px-2 py-0.5 rounded-full bg-white/5 text-white/40 border border-white/10">
                  {state.data?.meetings?.length || 0}
                </span>
              </div>
              <div className="space-y-3">
                {(state.data?.meetings || [])
                  .filter((m) => (m.room_name || "").toLowerCase().includes(search.toLowerCase()))
                  .map((m) => {
                    const isActive = selectedId === m.id;
                    return (
                      <button
                        key={m.id}
                        onClick={() => setSelectedId(m.id)}
                        className={cn("w-full text-left p-5 rounded-2xl transition-all border outline-none focus-visible:ring-2 focus-visible:ring-primary", isActive ? "slate-card-active" : "slate-card border-transparent hover:border-white/10")}
                      >
                        <div className="flex flex-col gap-3 min-w-0">
                          <div className="flex items-start justify-between gap-3">
                            <h4 className={cn("font-bold text-sm leading-tight truncate flex-1", isActive ? "text-primary" : "text-white/80")}>{m.room_name || `Untitled Session ${m.room_id.slice(0, 4)}`}</h4>
                            <div className={cn("w-2 h-2 rounded-full shrink-0 mt-1.5 shadow-[0_0_8px_rgba(27,182,166,0.3)]", m.status === "ready" ? "bg-primary" : "bg-white/10")} />
                          </div>
                          <div className="flex items-center gap-5 text-[11px] font-bold text-white/30 tracking-tight tabular-nums">
                            <span className="flex items-center gap-2 min-w-0 truncate">
                              <HugeiconsIcon icon={Calendar01Icon} size={14} aria-hidden="true" /> {new Date(m.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                            </span>
                            <span className="flex items-center gap-2 shrink-0">
                              <HugeiconsIcon icon={Clock01Icon} size={14} aria-hidden="true" /> {formatDuration(m.duration_seconds || 0)}
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
        <main className="flex-1 min-w-0 bg-black/40 h-[calc(100vh-4rem)] overflow-y-auto outline-none" tabIndex={-1}>
          {selectedMeeting ? (
            <div className="p-10 lg:p-16 max-w-6xl mx-auto animate-in fade-in slide-in-from-right-4 duration-500">
              {/* Header Container */}
              <div className="mb-12 space-y-8">
                <div className="flex items-center justify-between flex-wrap gap-4">
                  <div className="flex items-center gap-4">
                    <Badge variant={selectedMeeting.status === "ready" ? "default" : "secondary"} className="rounded-lg font-black text-[10px] tracking-widest px-3 py-1 bg-primary/20 text-primary border-primary/20">
                      {selectedMeeting.status === "ready" ? "READY" : "PROCESSING"}
                    </Badge>
                    <span className="text-[11px] font-bold font-mono text-white/30 tracking-tight">ID: {selectedMeeting.id}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={selectedMeeting.status !== "ready"}
                      onClick={() =>
                        createShareLink(selectedMeeting.id, state.token)
                          .then(() => toast.success("Link copied to clipboard"))
                          .catch((e) => toast.error(e.message))
                      }
                      className="font-bold h-10 px-6 bg-black/40 border-white/10 hover:border-primary/50 text-white/60 hover:text-white rounded-xl transition-all"
                    >
                      <HugeiconsIcon icon={Share01Icon} size={16} className="mr-2" aria-hidden="true" /> Share Link
                    </Button>
                    <Button
                      size="sm"
                      disabled={selectedMeeting.status !== "ready"}
                      onClick={() =>
                        downloadRecording(selectedMeeting.id, state.token)
                          .then(() => toast.success("Download started"))
                          .catch((e) => toast.error(e.message))
                      }
                      className="font-bold h-10 px-6 rounded-xl shadow-xl shadow-primary/20 hover:scale-105 active:scale-95 transition-all"
                    >
                      <HugeiconsIcon icon={Download01Icon} size={16} className="mr-2" aria-hidden="true" /> Download
                    </Button>
                  </div>
                </div>

                <h1 className="text-4xl lg:text-5xl font-black tracking-tighter text-white text-balance max-w-3xl leading-none">{selectedMeeting.room_name || "Untitled Meeting Session"}</h1>
              </div>

              {/* Bento Grid layout */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                {/* Stats row - Bento boxes */}
                <div className="md:col-span-3 grid grid-cols-1 sm:grid-cols-3 gap-8">
                  {[
                    {
                      label: "Captured On",
                      val: new Date(selectedMeeting.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }),
                      sub: new Date(selectedMeeting.created_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
                      icon: Calendar01Icon,
                    },
                    { label: "Archive Length", val: formatDuration(selectedMeeting.duration_seconds || 0), sub: "Recorded session", icon: Clock01Icon },
                    { label: "Data Volume", val: formatBytes(selectedMeeting.size_bytes || 0), sub: "Secured in cloud", icon: Database01Icon },
                  ].map((item, i) => (
                    <Card key={i} className="slate-card border-none hover:bg-white/[0.05] group">
                      <CardContent className="p-6 flex items-start gap-5">
                        <div className="w-12 h-12 rounded-2xl bg-white/[0.03] border border-white/[0.05] flex items-center justify-center shrink-0 group-hover:scale-110 group-hover:border-primary/30 transition-all duration-500">
                          <HugeiconsIcon icon={item.icon} size={24} className="text-primary/70" aria-hidden="true" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-[10px] font-black text-white/20 uppercase tracking-[0.2em] leading-none mb-2">{item.label}</p>
                          <p className="text-xl font-bold text-white tabular-nums truncate tracking-tight">{item.val}</p>
                          <p className="text-[11px] text-white/30 font-bold mt-1 truncate tracking-wide">{item.sub}</p>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>

                {/* Video Player Box */}
                <div className="md:col-span-3">
                  <Card className="bg-black/40 border-white/10 shadow-2xl overflow-hidden flex flex-col group rounded-3xl">
                    {isFetchingVideo ? (
                      <div className="w-full aspect-video flex flex-col items-center justify-center bg-black/60">
                        <ChalkLoader size={48} />
                        <p className="text-xs font-black uppercase tracking-[0.3em] text-white/20 mt-6 animate-pulse">Initializing Playback</p>
                      </div>
                    ) : videoError ? (
                      <div className="w-full aspect-video flex flex-col items-center justify-center p-12 text-center bg-black/20">
                        <div className="w-16 h-16 rounded-2xl bg-white/5 flex items-center justify-center mb-4 border border-white/10">
                          <HugeiconsIcon icon={Video01Icon} size={32} className="text-white/20" aria-hidden="true" />
                        </div>
                        <p className="text-lg font-bold text-white/80">Visual Feed Unavailable</p>
                        <p className="text-sm text-white/40 mt-2 max-w-xs mx-auto font-medium">{videoError}</p>
                      </div>
                    ) : recordingUrl ? (
                      <div className="w-full aspect-video bg-black relative">
                        <VideoPlayer url={recordingUrl} className="w-full h-full rounded-none border-0" />
                      </div>
                    ) : null}
                  </Card>
                </div>

                {/* Intelligence Content - Slate Boxes */}
                <Card className="md:col-span-2 slate-card border-none flex flex-col hover:bg-white/[0.03]">
                  <CardHeader className="p-8 pb-4 border-b border-white/[0.05]">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0 border border-primary/20">
                        <HugeiconsIcon icon={File02Icon} size={20} className="text-primary" aria-hidden="true" />
                      </div>
                      <CardTitle className="text-xs font-black uppercase tracking-[0.2em] text-white/50">Intelligence Summary</CardTitle>
                    </div>
                  </CardHeader>
                  <CardContent className="p-8 flex-1">
                    <p className="text-[17px] font-medium text-white/70 leading-relaxed text-pretty tracking-tight">
                      {selectedMeeting.transcript_summary ? (
                        selectedMeeting.transcript_summary
                      ) : (
                        <span className="italic text-white/20 flex items-center gap-3">
                          <Loader2 className="w-5 h-5 animate-spin text-primary/50" />
                          Synthesizing session context…
                        </span>
                      )}
                    </p>
                  </CardContent>
                </Card>

                <Card className="md:col-span-1 slate-card border-none flex flex-col hover:bg-white/[0.03]">
                  <CardHeader className="p-8 pb-4 border-b border-white/[0.05]">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0 border border-primary/20">
                          <HugeiconsIcon icon={CheckmarkCircle01Icon} size={20} className="text-primary" aria-hidden="true" />
                        </div>
                        <CardTitle className="text-xs font-black uppercase tracking-[0.2em] text-white/50">Action Items</CardTitle>
                      </div>
                      {selectedMeeting.transcript_action_items && selectedMeeting.transcript_action_items.length > 0 && (
                        <span className="font-mono text-[10px] px-2 py-0.5 rounded-md bg-primary/20 text-primary border border-primary/20">
                          {selectedMeeting.transcript_action_items.length}
                        </span>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent className="p-0 flex-1 overflow-y-auto max-h-[500px] scrollbar-hide">
                    <div className="flex flex-col">
                      {selectedMeeting.transcript_action_items && selectedMeeting.transcript_action_items.length > 0 ? (
                        selectedMeeting.transcript_action_items.map((item, idx) => (
                          <div key={idx} className="p-6 border-b border-white/[0.05] last:border-0 flex gap-5 hover:bg-white/[0.02] transition-colors group">
                            <span className="w-7 h-7 rounded-lg bg-white/5 text-white/40 flex items-center justify-center text-[12px] font-black shrink-0 shadow-inner group-hover:bg-primary/20 group-hover:text-primary transition-all duration-300 tabular-nums">{idx + 1}</span>
                            <span className="text-[14px] font-bold text-white/60 group-hover:text-white/90 leading-snug pt-0.5 transition-colors">{item}</span>
                          </div>
                        ))
                      ) : (
                        <div className="p-12 text-center flex flex-col items-center justify-center h-full opacity-20">
                          <HugeiconsIcon icon={CheckmarkCircle01Icon} size={40} className="text-white/50 mb-4" aria-hidden="true" />
                          <p className="text-xs font-black uppercase tracking-widest italic">Clear Agenda</p>
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>
          ) : (
            <div className="h-full flex items-center justify-center p-16 text-center">
              <div className="max-w-md space-y-8 animate-in fade-in zoom-in-95 duration-1000">
                <div className="mx-auto w-32 h-32 rounded-[2.5rem] bg-black/40 border border-white/[0.05] shadow-2xl flex items-center justify-center relative group overflow-hidden">
                  <div className="absolute inset-0 bg-primary/10 opacity-0 group-hover:opacity-100 transition-opacity duration-700 blur-2xl" />
                  <HugeiconsIcon icon={Video01Icon} size={64} className="text-white/10 group-hover:text-primary/40 transition-all duration-700 transform group-hover:scale-110" aria-hidden="true" />
                </div>
                <div className="space-y-3">
                  <h3 className="text-2xl font-black tracking-tight text-white/80">Select a Session</h3>
                  <p className="text-sm font-bold text-white/30 text-pretty leading-relaxed">
                    Choose an entry from your creative archive to unlock intelligent insights, automated tasks, and full playback.
                  </p>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function NotificationStack({ notifications, onDismiss }: { notifications: any[], onDismiss: any }) {
  return null;
}
