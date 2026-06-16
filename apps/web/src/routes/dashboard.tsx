import type { RoomResource } from "@q9labs/chalk-core";
import { useChalk } from "@q9labs/chalk-react";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@q9labs/chalk-ui";
import { AlertCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useTheme } from "../context/theme";
import { fetchInternalAccessToken, getApiUrl, logoutInternalSession, startGoogleOAuthSignIn } from "../lib/internalAuth";
import { useProfileAvatar } from "../lib/useProfileAvatar";
import { getRecordingPlaybackUrl, getRecordingShareUrl, downloadRecordingFromDashboard } from "../lib/dashboardMeetings";
import { WebChalkRuntime } from "../components/WebChalkRuntime";
import { SettingsModal } from "../components/SettingsModal";

// Sub-components
import { DashboardLogin } from "../features/dashboard/components/DashboardLogin";
import { DashboardHeader } from "../features/dashboard/components/DashboardHeader";
import { DashboardSidebar } from "../features/dashboard/components/DashboardSidebar";
import { DashboardDetail } from "../features/dashboard/components/DashboardDetail";
import type { Meeting, MeetingsResponse } from "../features/dashboard/types";

export const Route = createFileRoute("/dashboard")({
  component: DashboardPage,
});

const asRecord = (value: unknown): Record<string, unknown> | null => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

function isMeeting(value: unknown): value is Meeting {
  const record = asRecord(value);
  if (!record) return false;

  return typeof record.id === "string" && typeof record.room_id === "string" && (typeof record.room_name === "string" || record.room_name === null) && (record.status === "ready" || record.status === "processing" || record.status === "error") && typeof record.created_at === "string";
}

function parseMeetingsResponse(value: unknown): MeetingsResponse {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.meetings)) {
    throw new Error("invalid meetings response");
  }

  return {
    meetings: record.meetings.filter(isMeeting),
  };
}

function readJwtEmail(token: string) {
  const payloadPart = token.split(".")[1];
  if (!payloadPart) return "";

  try {
    const payload = payloadPart
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(payloadPart.length / 4) * 4, "=");
    const decoded = typeof atob === "function" ? atob(payload) : Buffer.from(payload, "base64").toString("utf8");
    const claims = asRecord(JSON.parse(decoded));
    return typeof claims?.email === "string" ? claims.email : "";
  } catch {
    return "";
  }
}

async function createShareLink(recordingId: string, token: string) {
  const url = await getRecordingShareUrl(getApiUrl(), recordingId, token);
  await navigator.clipboard.writeText(url);
}

async function downloadRecording(recordingId: string, token: string) {
  await downloadRecordingFromDashboard(getApiUrl(), recordingId, token);
}

function DashboardPage() {
  return <WebChalkRuntime fallback={<div className="min-h-screen bg-background" />}>{() => <DashboardPageContent />}</WebChalkRuntime>;
}

function DashboardPageContent() {
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

  useEffect(() => {
    fetchInternalAccessToken(apiUrl)
      .then(async (token: string | null) => {
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
        const data = parseMeetingsResponse(await res.json());
        setState({ kind: "ready", data, token });
        const firstMeeting = data.meetings[0];
        if (firstMeeting) setSelectedId(firstMeeting.id);
      })
      .catch((error: unknown) =>
        setState({
          kind: "error",
          message: error instanceof Error ? error.message : "Failed to load meetings",
        }),
      );
  }, [apiUrl]);

  useEffect(() => {
    if (state.kind !== "ready" || !selectedId) return;
    setIsFetchingVideo(true);
    setVideoError(null);
    setRecordingUrl(null);

    getRecordingPlaybackUrl(apiUrl, selectedId, state.token)
      .then((url: string) => {
        setRecordingUrl(url);
      })
      .catch((error: unknown) => setVideoError(error instanceof Error ? error.message : "Playback unavailable"))
      .finally(() => setIsFetchingVideo(false));
  }, [apiUrl, selectedId, state]);

  const selectedMeeting = useMemo(() => {
    if (state.kind !== "ready") return null;
    return state.data.meetings.find((m) => m.id === selectedId) || null;
  }, [state, selectedId]);

  const startGoogleSignIn = async () => {
    try {
      setIsSigningIn(true);
      await startGoogleOAuthSignIn(apiUrl);
      window.location.reload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Google sign-in failed");
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
    return readJwtEmail(state.token);
  }, [state]);

  const avatarProfile = useProfileAvatar({
    displayNameOverride: userEmail,
    fallbackSeed: userEmail,
  });

  // Scheduled rooms panel integration
  const sdkClient = useChalk();
  const [scheduledRooms, setScheduledRooms] = useState<RoomResource[]>([]);
  const [roomsLoading, setRoomsLoading] = useState(false);
  const [roomsError, setRoomsError] = useState<string | null>(null);

  const refreshRooms = useCallback(async () => {
    setRoomsLoading(true);
    setRoomsError(null);
    try {
      const response = await sdkClient.listRooms({
        status: ["scheduled", "active"],
        limit: 50,
      });
      setScheduledRooms(response.rooms);
    } catch (e: any) {
      setRoomsError(e?.message ?? "Failed to load scheduled sessions");
    } finally {
      setRoomsLoading(false);
    }
  }, [sdkClient]);

  useEffect(() => {
    if (state.kind !== "ready") return;
    void refreshRooms();
  }, [refreshRooms, state.kind]);

  if (state.kind === "loading") {
    return <DashboardLoadingState />;
  }

  if (state.kind === "error") {
    return (
      <div className="font-app min-h-screen bg-background flex items-center justify-center p-6 text-center">
        <Card className="max-w-md w-full bg-background border-border/40 shadow-xl rounded-3xl overflow-hidden">
          <CardHeader className="pt-10">
            <div className="mx-auto w-16 h-16 rounded-2xl bg-destructive/10 text-destructive flex items-center justify-center mb-4">
              <HugeiconsIcon icon={AlertCircleIcon} size={32} />
            </div>
            <CardTitle className="text-2xl font-bold tracking-tight text-foreground">Connection Error</CardTitle>
            <CardDescription className="text-muted-foreground font-medium px-4">{state.message}</CardDescription>
          </CardHeader>
          <CardContent className="pb-10 px-8">
            <Button onClick={() => window.location.reload()} className="w-full h-12 rounded-xl font-bold transition-all">
              Retry Connection
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (state.kind === "login") {
    return <DashboardLogin onSignIn={startGoogleSignIn} isSigningIn={isSigningIn} />;
  }

  return (
    <div className="font-app min-h-screen bg-background selection:bg-primary/20 flex flex-col text-foreground overflow-hidden">
      <DashboardHeader userEmail={userEmail} avatarProfile={avatarProfile} theme={theme} toggleTheme={toggleTheme} onOpenSettings={() => setIsSettingsOpen(true)} onLogout={handleLogout} />

      <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />

      {/* Main Content Area - Slim Sidebar & Content Split */}
      <div className="flex-1 flex w-full relative overflow-hidden">
        <DashboardSidebar meetings={state.data.meetings} search={search} onSearchChange={setSearch} selectedId={selectedId} onSelectMeeting={setSelectedId} sdkClient={sdkClient} scheduledRooms={scheduledRooms} roomsLoading={roomsLoading} roomsError={roomsError} onRefreshRooms={refreshRooms} />

        <main className="flex-1 min-w-0 bg-background h-[calc(100vh-4rem)] overflow-y-auto outline-none" tabIndex={-1}>
          <DashboardDetail
            meeting={selectedMeeting}
            recordingUrl={recordingUrl}
            isFetchingVideo={isFetchingVideo}
            videoError={videoError}
            token={state.token}
            onShare={(id, token) =>
              createShareLink(id, token)
                .then(() => toast.success("Link copied to clipboard"))
                .catch((e) => toast.error(e.message))
            }
            onDownload={(id, token) =>
              downloadRecording(id, token)
                .then(() => toast.success("Download started"))
                .catch((e) => toast.error(e.message))
            }
          />
        </main>
      </div>
    </div>
  );
}

function DashboardLoadingState() {
  return <DashboardLoadingShell />;
}

function DashboardLoadingShell() {
  return (
    <div className="font-app min-h-screen bg-background selection:bg-primary/20 flex flex-col text-foreground overflow-hidden">
      <header className="flex h-16 items-center justify-between border-b border-border/40 px-6">
        <div className="h-6 w-32 rounded-md bg-muted/70" />
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-full bg-muted/70" />
          <div className="h-9 w-24 rounded-xl bg-muted/70" />
        </div>
      </header>
      <div className="flex flex-1 w-full overflow-hidden">
        <aside className="hidden w-[320px] border-r border-border/40 bg-card/30 p-4 md:flex md:flex-col">
          <div className="h-10 rounded-xl bg-muted/70" />
          <div className="mt-4 space-y-3">
            {Array.from({ length: 7 }).map((_, index) => (
              <div key={index} className="rounded-2xl border border-border/40 bg-background/70 p-4">
                <div className="h-4 w-32 rounded bg-muted/70" />
                <div className="mt-3 h-3 w-24 rounded bg-muted/70" />
                <div className="mt-2 h-3 w-40 rounded bg-muted/70" />
              </div>
            ))}
          </div>
        </aside>

        <main className="flex-1 min-w-0 bg-background h-[calc(100vh-4rem)] overflow-y-auto p-6 md:p-8">
          <div className="mx-auto max-w-5xl space-y-6">
            <section className="rounded-[28px] border border-border/40 bg-card/40 p-6 shadow-sm">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="space-y-3">
                  <div className="h-7 w-56 rounded bg-muted/70" />
                  <div className="h-4 w-80 max-w-full rounded bg-muted/70" />
                  <div className="h-4 w-64 max-w-full rounded bg-muted/70" />
                </div>
                <div className="flex gap-3">
                  <div className="h-11 w-28 rounded-xl bg-muted/70" />
                  <div className="h-11 w-28 rounded-xl bg-muted/70" />
                </div>
              </div>
              <div className="mt-6 grid gap-4 md:grid-cols-3">
                {Array.from({ length: 3 }).map((_, index) => (
                  <div key={index} className="rounded-2xl border border-border/40 bg-background/70 p-4">
                    <div className="h-3 w-20 rounded bg-muted/70" />
                    <div className="mt-4 h-8 w-16 rounded bg-muted/70" />
                    <div className="mt-3 h-3 w-24 rounded bg-muted/70" />
                  </div>
                ))}
              </div>
            </section>

            <section className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(340px,0.85fr)]">
              <div className="rounded-[28px] border border-border/40 bg-card/40 p-6 shadow-sm">
                <div className="h-5 w-40 rounded bg-muted/70" />
                <div className="mt-6 aspect-video rounded-[24px] bg-muted/70" />
                <div className="mt-6 grid gap-3 sm:grid-cols-3">
                  {Array.from({ length: 3 }).map((_, index) => (
                    <div key={index} className="h-16 rounded-2xl bg-muted/70" />
                  ))}
                </div>
              </div>

              <div className="rounded-[28px] border border-border/40 bg-card/40 p-6 shadow-sm">
                <div className="h-5 w-36 rounded bg-muted/70" />
                <div className="mt-6 space-y-4">
                  {Array.from({ length: 5 }).map((_, index) => (
                    <div key={index} className="rounded-2xl border border-border/40 bg-background/70 p-4">
                      <div className="h-4 w-32 rounded bg-muted/70" />
                      <div className="mt-3 h-3 w-full rounded bg-muted/70" />
                      <div className="mt-2 h-3 w-2/3 rounded bg-muted/70" />
                    </div>
                  ))}
                </div>
              </div>
            </section>
          </div>
        </main>
      </div>
    </div>
  );
}
