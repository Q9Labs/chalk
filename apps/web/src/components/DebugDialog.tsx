import React, { useEffect, useMemo, useState } from "react";
import { cn } from "@q9labs/chalk-ui";
import { useParticipants, useRoom, useSession } from "@q9labs/chalk-react";
import { useRouterState } from "@tanstack/react-router";
import { TerminalIcon, ShieldCheckIcon, MonitorIcon, CopyIcon, CheckIcon, XIcon, CpuIcon, LinkIcon, UserIcon } from "lucide-react";
import { formatBuildTime, formatRemaining, getBrowserAndOs, getParticipantSeed, getParticipantThemeVariables, getRouteRoomId, resolveParticipantId } from "./debugDialogUtils";

function InfoRow({ label, value, mono = false, title, valueClassName }: { label: string; value: string; mono?: boolean; title?: string; valueClassName?: string }) {
  return (
    <>
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("min-w-0 truncate text-right text-card-foreground", mono && "font-mono text-xs", valueClassName)} title={title ?? value}>
        {value}
      </span>
    </>
  );
}

type MeetingRow = {
  label: string;
  value: string;
  mono?: boolean;
  title?: string;
};

export interface DebugDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export const DebugDialog: React.FC<DebugDialogProps> = ({ isOpen, onClose }) => {
  const session = useSession();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const { roomId: connectedRoomId, roomName, status } = useRoom();
  const { localParticipant } = useParticipants();
  const [copied, setCopied] = useState(false);
  const [currentTime, setCurrentTime] = useState(Date.now());

  useEffect(() => {
    if (!isOpen) return;
    const interval = window.setInterval(() => setCurrentTime(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [isOpen]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isOpen) return;
      if (event.key === "Escape") onClose();
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  const authInfo = useMemo(() => {
    const expiresStr = typeof window !== "undefined" ? sessionStorage.getItem("chalk_token_expires") : null;

    if (!expiresStr) {
      return {
        status: "Not Logged In",
        remaining: null,
        color: "text-muted-foreground",
      };
    }

    const expiresAt = Number(expiresStr);
    const diff = expiresAt - currentTime;

    if (diff <= 0) {
      return { status: "Expired", remaining: 0, color: "text-destructive" };
    }

    if (diff < 60000) {
      return {
        status: "Expiring Soon",
        remaining: diff,
        color: "text-amber-500",
      };
    }

    return { status: "Valid", remaining: diff, color: "text-green-500" };
  }, [currentTime]);

  const systemInfo = useMemo(() => getBrowserAndOs(), []);
  const routeRoomId = useMemo(() => getRouteRoomId(pathname), [pathname]);
  const room = session.room.getRoom();
  const rtkConnectionStatus = status || session.chalkClient.connectionState;
  const wsConnectionStatus = session.chalkClient.websocketConnectionState;
  const resolvedParticipantId = resolveParticipantId(localParticipant?.id, room?.localParticipant?.id, session.chalkClient.localParticipantId);
  const resolvedParticipantName = localParticipant?.displayName ?? room?.localParticipant?.displayName ?? "N/A";
  const resolvedParticipantRole = localParticipant?.role ?? room?.localParticipant?.role ?? "N/A";
  const resolvedConnectedRoomId = connectedRoomId ?? room?.id ?? "N/A";
  const participantSeed = getParticipantSeed({
    displayName: resolvedParticipantName === "N/A" ? null : resolvedParticipantName,
    participantId: resolvedParticipantId === "N/A" ? null : resolvedParticipantId,
    routeRoomId,
  });
  const themeVariables = useMemo(() => getParticipantThemeVariables(participantSeed), [participantSeed]);

  const meetingRows: MeetingRow[] = [
    {
      label: "Meeting Code",
      value: routeRoomId ?? "N/A",
      mono: true,
      title: routeRoomId ?? undefined,
    },
    {
      label: "Session UUID",
      value: resolvedConnectedRoomId,
      mono: true,
      title: resolvedConnectedRoomId,
    },
    {
      label: "Participant ID",
      value: resolvedParticipantId,
      mono: true,
      title: resolvedParticipantId,
    },
    {
      label: "Display Name",
      value: resolvedParticipantName,
      title: resolvedParticipantName,
    },
    {
      label: "Role / Status",
      value: `${resolvedParticipantRole} / ${rtkConnectionStatus}`,
      title: `${resolvedParticipantRole} / ${rtkConnectionStatus}`,
    },
    {
      label: "RTK Status",
      value: rtkConnectionStatus,
      title: rtkConnectionStatus,
    },
    {
      label: "WS Status",
      value: wsConnectionStatus,
      title: wsConnectionStatus,
    },
    {
      label: "Room Name",
      value: roomName ?? room?.info?.name ?? "N/A",
      title: roomName ?? room?.info?.name ?? undefined,
    },
  ];

  const handleCopy = () => {
    const debugText = `
Chalk Debug Info
----------------
SDK React Version: ${__SDK_REACT_VERSION__}
Web App Version: ${__WEB_APP_VERSION__}
Commit: ${__COMMIT_HASH__}
Built: ${__BUILD_TIME__}

Meeting:
Meeting Code: ${routeRoomId || "N/A"}
Session UUID: ${resolvedConnectedRoomId}
Participant ID: ${resolvedParticipantId}
Display Name: ${resolvedParticipantName}
Role: ${resolvedParticipantRole}
Room Name: ${roomName || room?.info?.name || "N/A"}
Connection Status: ${status}
RTK Status: ${rtkConnectionStatus}
WS Status: ${wsConnectionStatus}

Auth Status: ${authInfo.status}
Auth Remaining: ${authInfo.remaining !== null ? formatRemaining(authInfo.remaining) : "N/A"}

System:
OS: ${systemInfo.os}
Browser: ${systemInfo.browser}
Screen: ${systemInfo.screen} (@${systemInfo.dpr}x)
Language: ${systemInfo.lang}
Timezone: ${systemInfo.timezone}
Online: ${systemInfo.online ? "yes" : "no"}
URL: ${typeof window !== "undefined" ? window.location.href : "N/A"}
User Agent: ${systemInfo.userAgent}
`.trim();

    void navigator.clipboard.writeText(debugText);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm" role="dialog" aria-modal="true">
      <div className="flex w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border/80 bg-card/95 shadow-2xl shadow-black/40 backdrop-blur-xl animate-in fade-in zoom-in-95 duration-200" style={themeVariables}>
        <div className="border-b border-border/60 bg-gradient-to-r from-transparent via-[color:var(--primary)]/8 to-transparent px-6 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <div className="rounded-full border border-[color:var(--primary)]/20 bg-[color:var(--primary)]/12 p-2 text-[color:var(--primary)]">
                  <TerminalIcon size={16} />
                </div>
                <div>
                  <div className="font-semibold text-card-foreground">System Information</div>
                  <div className="text-xs text-muted-foreground">Runtime, room, auth, browser</div>
                </div>
              </div>
              <div className="flex flex-wrap gap-2 text-[11px]">
                <span className="rounded-full border border-border/60 bg-muted/50 px-2.5 py-1 text-muted-foreground">SDK React v{__SDK_REACT_VERSION__}</span>
                <span className="rounded-full border border-border/60 bg-muted/50 px-2.5 py-1 text-muted-foreground">Web v{__WEB_APP_VERSION__}</span>
                <span className="rounded-full border border-border/60 bg-muted/50 px-2.5 py-1 font-mono text-muted-foreground">{__COMMIT_HASH__}</span>
              </div>
            </div>
            <button onClick={onClose} className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-card-foreground" aria-label="Close system information">
              <XIcon size={18} />
            </button>
          </div>
        </div>

        <div className="max-h-[72vh] space-y-6 overflow-y-auto px-6 py-5">
          <section className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              <CpuIcon size={14} />
              Build & Version
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] gap-x-4 gap-y-2 rounded-xl border border-border/60 bg-muted/20 px-4 py-3 text-sm">
              <InfoRow label="SDK React" value={`v${__SDK_REACT_VERSION__}`} mono />
              <InfoRow label="Web App" value={`v${__WEB_APP_VERSION__}`} mono />
              <InfoRow label="Commit" value={__COMMIT_HASH__} mono />
              <InfoRow label="Built At" value={formatBuildTime(__BUILD_TIME__)} />
            </div>
          </section>

          <section className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              <LinkIcon size={14} />
              Meeting Session
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] gap-x-4 gap-y-2 rounded-xl border border-border/60 bg-muted/20 px-4 py-3 text-sm">
              {meetingRows.map((row) => (
                <InfoRow key={row.label} label={row.label} value={row.value} mono={row.mono} title={row.title} />
              ))}
            </div>
          </section>

          <section className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              <ShieldCheckIcon size={14} />
              Authentication
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] gap-x-4 gap-y-2 rounded-xl border border-border/60 bg-muted/20 px-4 py-3 text-sm">
              <InfoRow label="Status" value={authInfo.status} valueClassName={cn("font-medium", authInfo.color)} />
              <InfoRow label="Expires In" value={authInfo.remaining !== null ? formatRemaining(authInfo.remaining) : "N/A"} mono />
            </div>
          </section>

          <section className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              <MonitorIcon size={14} />
              System Specs
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] gap-x-4 gap-y-2 rounded-xl border border-border/60 bg-muted/20 px-4 py-3 text-sm">
              <InfoRow label="OS / Browser" value={`${systemInfo.os} / ${systemInfo.browser}`} />
              <InfoRow label="Screen" value={`${systemInfo.screen} (@${systemInfo.dpr}x)`} />
              <InfoRow label="Language" value={systemInfo.lang} />
              <InfoRow label="Timezone" value={systemInfo.timezone} />
              <InfoRow label="Network" value={systemInfo.online ? "Online" : "Offline"} />
            </div>
          </section>

          <section className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              <UserIcon size={14} />
              Quick Notes
            </div>
            <div className="rounded-xl border border-border/60 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">Shows both the meeting code from the URL and the connected backend session UUID. Copy bundle includes both so support can match user reports with server logs.</div>
          </section>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border/60 bg-muted/20 px-6 py-4">
          <button
            onClick={handleCopy}
            className={cn(
              "flex flex-1 items-center justify-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-semibold transition-all focus:outline-none focus:ring-2 focus:ring-[color:var(--ring)] focus:ring-offset-2 focus:ring-offset-card",
              copied ? "border-green-500/30 bg-green-500/10 text-green-500" : "border-[color:var(--primary)]/25 text-[color:var(--primary-foreground)] shadow-lg shadow-[color:var(--primary)]/20 hover:brightness-110",
            )}
            style={
              copied
                ? undefined
                : {
                    background: "var(--primary-gradient, linear-gradient(135deg, var(--primary) 0%, var(--primary) 100%))",
                  }
            }
          >
            {copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
            {copied ? "Copied!" : "Copy Debug Bundle"}
          </button>
          <button onClick={onClose} className="rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-card-foreground transition-colors hover:bg-muted">
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
