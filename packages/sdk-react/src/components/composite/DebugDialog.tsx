import React, { useEffect, useMemo, useState } from "react";

import { useParticipants } from "../../hooks/participants/useParticipants";
import { useRoom } from "../../hooks/room/useRoom";
import { useSession } from "../../context/chalk-provider";
import { getParticipantThemeVariables } from "../../utils/colorGenerator";
import { cn } from "../../utils/cn";
import { downloadDebugText, prepareFullDebugExport, type PreparedDebugExport } from "../../utils/debugExport";
import { Cancel01Icon, Clock01Icon, Download01Icon, InformationCircleIcon, Link01Icon, Monitor01Icon, Shield01Icon } from "../../utils/icons";

function getRouteRoomId(pathname: string) {
  const match = pathname.match(/^\/room\/([^/?#]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function formatRemaining(ms: number | null) {
  if (ms === null) {
    return "N/A";
  }

  const seconds = Math.floor((ms / 1000) % 60);
  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const parts: string[] = [];

  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0 || hours > 0) {
    parts.push(`${minutes}m`);
  }
  parts.push(`${seconds}s`);
  return parts.join(" ");
}

function formatDateTime(value: string | undefined) {
  if (!value) {
    return "N/A";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function getSystemInfo() {
  if (typeof window === "undefined") {
    return {
      browser: "Unknown",
      os: "Unknown",
      screen: "Unknown",
      dpr: 1,
      language: "Unknown",
      timezone: "Unknown",
      online: false,
    };
  }

  const ua = navigator.userAgent;
  let browser = "Unknown";
  if (ua.includes("Chrome")) browser = "Chrome";
  else if (ua.includes("Safari")) browser = "Safari";
  else if (ua.includes("Firefox")) browser = "Firefox";
  else if (ua.includes("Edge")) browser = "Edge";

  let os = "Unknown";
  if (ua.includes("Mac")) os = "macOS";
  else if (ua.includes("Win")) os = "Windows";
  else if (ua.includes("Linux")) os = "Linux";
  else if (ua.includes("Android")) os = "Android";
  else if (ua.includes("iPhone") || ua.includes("iPad")) os = "iOS";

  return {
    browser,
    os,
    screen: `${window.screen.width}x${window.screen.height}`,
    dpr: window.devicePixelRatio,
    language: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    online: navigator.onLine,
  };
}

function InfoRow({ label, value, mono = false, valueClassName }: { label: string; value: string; mono?: boolean; valueClassName?: string }) {
  return (
    <>
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("min-w-0 truncate text-right text-card-foreground", mono && "font-mono text-xs", valueClassName)} title={value}>
        {value}
      </span>
    </>
  );
}

function getAuthInfo(expiresAt: number | null | undefined, now: number) {
  if (!expiresAt) {
    return {
      status: "Unavailable",
      remaining: null,
      color: "text-muted-foreground",
    };
  }

  const remaining = expiresAt - now;
  if (remaining <= 0) {
    return {
      status: "Expired",
      remaining: 0,
      color: "text-destructive",
    };
  }

  if (remaining < 60_000) {
    return {
      status: "Expiring soon",
      remaining,
      color: "text-amber-500",
    };
  }

  return {
    status: "Valid",
    remaining,
    color: "text-green-500",
  };
}

export interface DebugDialogApplicationInfo {
  name?: string;
  version?: string;
  commitHash?: string;
  builtAt?: string;
}

export interface DebugDialogProps {
  isOpen: boolean;
  onClose: () => void;
  application?: DebugDialogApplicationInfo;
  authExpiresAt?: number | null;
  routePathname?: string;
  participantColorSeed?: string;
}

export const DebugDialog = React.memo(({ isOpen, onClose, application, authExpiresAt = null, routePathname, participantColorSeed }: DebugDialogProps) => {
  const session = useSession();
  const { roomId: connectedRoomId, roomName, status } = useRoom();
  const { localParticipant } = useParticipants();
  const [debugExportState, setDebugExportState] = useState<"idle" | "preparing" | "downloaded" | "failed">("idle");
  const [preparedDebugExport, setPreparedDebugExport] = useState<PreparedDebugExport | null>(null);
  const [currentTime, setCurrentTime] = useState(Date.now());

  useEffect(() => {
    if (!isOpen) {
      setPreparedDebugExport(null);
      setDebugExportState("idle");
      return;
    }

    const interval = window.setInterval(() => setCurrentTime(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [isOpen]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && isOpen) {
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  const room = session.room.getRoom();
  const activeRoomName = (room as { name?: string } | null)?.name ?? null;
  const resolvedParticipantId = localParticipant?.id ?? room?.localParticipant?.id ?? session.chalkClient.localParticipantId ?? "N/A";
  const resolvedParticipantName = localParticipant?.displayName ?? room?.localParticipant?.displayName ?? "N/A";
  const resolvedParticipantRole = localParticipant?.role ?? room?.localParticipant?.role ?? "N/A";
  const resolvedConnectedRoomId = connectedRoomId ?? room?.id ?? "N/A";
  const resolvedRoutePathname = routePathname ?? (typeof window !== "undefined" ? window.location.pathname : "");
  const routeRoomId = useMemo(() => getRouteRoomId(resolvedRoutePathname), [resolvedRoutePathname]);
  const connectionStatus = status || session.chalkClient.connectionState;
  const websocketStatus = session.chalkClient.websocketConnectionState;
  const systemInfo = useMemo(() => getSystemInfo(), []);
  const authInfo = useMemo(() => getAuthInfo(authExpiresAt, currentTime), [authExpiresAt, currentTime]);
  const themeVariables = useMemo(() => getParticipantThemeVariables(participantColorSeed ?? (resolvedParticipantName !== "N/A" ? resolvedParticipantName : routeRoomId ?? resolvedParticipantId)), [participantColorSeed, resolvedParticipantId, resolvedParticipantName, routeRoomId]);

  const applicationRows = [
    application?.name ? { label: "Application", value: application.name } : null,
    application?.version ? { label: "Version", value: application.version, mono: true } : null,
    application?.commitHash ? { label: "Commit", value: application.commitHash, mono: true } : null,
    application?.builtAt ? { label: "Built at", value: formatDateTime(application.builtAt) } : null,
  ].filter((row): row is { label: string; value: string; mono?: boolean } => Boolean(row));

  const handleDownloadDebug = async () => {
    try {
      setDebugExportState("preparing");
      const prepared =
        preparedDebugExport ??
        (await prepareFullDebugExport({
          source: "debug-dialog",
          routePathname: resolvedRoutePathname,
          routeRoomId,
          connectedRoomId: resolvedConnectedRoomId,
          roomName: roomName ?? activeRoomName,
          participantId: resolvedParticipantId,
          participantName: resolvedParticipantName,
          participantRole: resolvedParticipantRole,
          application,
        }));

      setPreparedDebugExport(prepared);
      downloadDebugText(prepared.text);
      setDebugExportState("downloaded");
      window.setTimeout(() => setDebugExportState("idle"), 2500);
    } catch {
      setDebugExportState("failed");
    }
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm" role="dialog" aria-modal="true">
      <div className="flex w-full max-w-xl flex-col overflow-hidden rounded-3xl border border-border/70 bg-card/95 shadow-2xl backdrop-blur-xl" style={themeVariables as React.CSSProperties}>
        <div className="border-b border-border/60 bg-gradient-to-r from-transparent via-[color:var(--primary)]/10 to-transparent px-6 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <div className="rounded-full border border-[color:var(--primary)]/20 bg-[color:var(--primary)]/12 p-2 text-[color:var(--primary)]">
                  <InformationCircleIcon className="h-4 w-4" />
                </div>
                <div>
                  <div className="font-semibold text-card-foreground">Diagnostics</div>
                  <div className="text-xs text-muted-foreground">Session, browser, and debug export tools</div>
                </div>
              </div>
            </div>
            <button onClick={onClose} className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-card-foreground" aria-label="Close diagnostics">
              <Cancel01Icon className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="max-h-[72vh] space-y-6 overflow-y-auto px-6 py-5">
          {applicationRows.length > 0 ? (
            <section className="space-y-2">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                <Clock01Icon className="h-4 w-4" />
                Build
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] gap-x-4 gap-y-2 rounded-2xl border border-border/60 bg-muted/20 px-4 py-3 text-sm">
                {applicationRows.map((row) => (
                  <InfoRow key={row.label} label={row.label} value={row.value} mono={row.mono} />
                ))}
              </div>
            </section>
          ) : null}

          <section className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              <Link01Icon className="h-4 w-4" />
              Meeting session
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] gap-x-4 gap-y-2 rounded-2xl border border-border/60 bg-muted/20 px-4 py-3 text-sm">
              <InfoRow label="Route room ID" value={routeRoomId ?? "N/A"} mono />
              <InfoRow label="Connected room ID" value={resolvedConnectedRoomId} mono />
              <InfoRow label="Room name" value={roomName ?? activeRoomName ?? "N/A"} />
              <InfoRow label="Connection" value={connectionStatus || "unknown"} mono />
              <InfoRow label="WebSocket" value={websocketStatus || "unknown"} mono />
              <InfoRow label="Participant" value={resolvedParticipantName} />
              <InfoRow label="Participant ID" value={resolvedParticipantId} mono />
              <InfoRow label="Role" value={resolvedParticipantRole} mono />
            </div>
          </section>

          <section className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              <Shield01Icon className="h-4 w-4" />
              Authentication
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] gap-x-4 gap-y-2 rounded-2xl border border-border/60 bg-muted/20 px-4 py-3 text-sm">
              <InfoRow label="Status" value={authInfo.status} valueClassName={cn("font-medium", authInfo.color)} />
              <InfoRow label="Expires in" value={formatRemaining(authInfo.remaining)} mono />
            </div>
          </section>

          <section className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              <Monitor01Icon className="h-4 w-4" />
              System
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] gap-x-4 gap-y-2 rounded-2xl border border-border/60 bg-muted/20 px-4 py-3 text-sm">
              <InfoRow label="Browser" value={systemInfo.browser} />
              <InfoRow label="OS" value={systemInfo.os} />
              <InfoRow label="Screen" value={systemInfo.screen} mono />
              <InfoRow label="DPR" value={String(systemInfo.dpr)} mono />
              <InfoRow label="Language" value={systemInfo.language} mono />
              <InfoRow label="Timezone" value={systemInfo.timezone} />
              <InfoRow label="Online" value={systemInfo.online ? "Yes" : "No"} />
            </div>
          </section>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border/60 bg-muted/20 px-6 py-4">
          <p className="text-xs text-muted-foreground">Download the full debug bundle if you need to share the current tab state with support.</p>
          <button
            type="button"
            onClick={() => {
              void handleDownloadDebug();
            }}
            className={cn("inline-flex h-11 items-center justify-center gap-2 rounded-full px-4 text-sm font-medium transition-colors", debugExportState === "failed" ? "bg-destructive/10 text-destructive hover:bg-destructive/15" : "bg-primary text-primary-foreground hover:bg-primary/90")}
          >
            <Download01Icon className="h-4 w-4" />
            {debugExportState === "preparing"
              ? "Preparing debug"
              : debugExportState === "downloaded"
                ? "Downloaded debug"
                : debugExportState === "failed"
                  ? "Retry debug export"
                  : "Download debug TXT"}
          </button>
        </div>
      </div>
    </div>
  );
});

DebugDialog.displayName = "DebugDialog";
