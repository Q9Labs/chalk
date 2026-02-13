import React, { useEffect, useState, useMemo } from "react";
import { cn } from "@q9labs/chalk-ui";
import { useRoom, useParticipants } from "@q9labs/chalk-react";
import { 
  TerminalIcon, 
  ShieldCheckIcon, 
  MonitorIcon, 
  CopyIcon, 
  CheckIcon,
  XIcon,
  CpuIcon,
  CalendarIcon,
  HashIcon
} from "lucide-react";

export interface DebugDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export const DebugDialog: React.FC<DebugDialogProps> = ({
  isOpen,
  onClose,
}) => {
  const { roomId } = useRoom();
  const { localParticipant } = useParticipants();
  const [copied, setCopied] = useState(false);
  const [currentTime, setCurrentTime] = useState(Date.now());

  // Update current time every second for expiry calculation
  useEffect(() => {
    if (!isOpen) return;
    const interval = setInterval(() => setCurrentTime(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [isOpen]);

  // Auth status info
  const authInfo = useMemo(() => {
    const expiresStr = typeof window !== "undefined" ? sessionStorage.getItem("chalk_token_expires") : null;
    if (!expiresStr) return { status: "Not Logged In", remaining: null, color: "text-muted-foreground" };

    const expiresAt = Number(expiresStr);
    const diff = expiresAt - currentTime;

    if (diff <= 0) return { status: "Expired", remaining: 0, color: "text-destructive" };
    if (diff < 60000) return { status: "Expiring Soon", remaining: diff, color: "text-amber-500" };
    
    return { status: "Valid", remaining: diff, color: "text-green-500" };
  }, [currentTime]);

  const formatRemaining = (ms: number | null) => {
    if (ms === null) return "";
    const seconds = Math.floor((ms / 1000) % 60);
    const minutes = Math.floor((ms / (1000 * 60)) % 60);
    const hours = Math.floor(ms / (1000 * 60 * 60));

    const parts = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0 || hours > 0) parts.push(`${minutes}m`);
    parts.push(`${seconds}s`);
    return parts.join(" ");
  };

  // System info
  const systemInfo = useMemo(() => {
    if (typeof window === "undefined") return {};
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
      lang: navigator.language,
    };
  }, []);

  const handleCopy = () => {
    const debugText = `
Chalk Debug Info
----------------
Version: ${__APP_VERSION__}
Commit: ${__COMMIT_HASH__}
Built: ${__BUILD_TIME__}

Meeting:
Room ID: ${roomId || "N/A"}
Participant ID: ${localParticipant?.id || "N/A"}

Auth Status: ${authInfo.status}
Auth Remaining: ${authInfo.remaining ? formatRemaining(authInfo.remaining) : "N/A"}

System:
OS: ${systemInfo.os}
Browser: ${systemInfo.browser}
Screen: ${systemInfo.screen} (@${systemInfo.dpr}x)
Language: ${systemInfo.lang}
User Agent: ${navigator.userAgent}
`.trim();

    navigator.clipboard.writeText(debugText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Handle keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-sm bg-background/80"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-xl shadow-lg bg-card border border-border flex flex-col animate-in fade-in zoom-in-95 duration-200"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <TerminalIcon size={20} className="text-primary" />
            <span className="font-semibold text-card-foreground">System Information</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-muted text-muted-foreground transition-colors"
          >
            <XIcon size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="px-6 py-4 space-y-6 overflow-y-auto max-h-[70vh]">
          {/* Build Info */}
          <section className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              <CpuIcon size={14} />
              Build & Version
            </div>
            <div className="grid grid-cols-2 gap-y-1.5 text-sm">
              <span className="text-muted-foreground flex items-center gap-1.5">
                <HashIcon size={14} /> Version
              </span>
              <span className="font-mono text-card-foreground">v{__APP_VERSION__}</span>
              
              <span className="text-muted-foreground flex items-center gap-1.5">
                <TerminalIcon size={14} /> Commit
              </span>
              <span className="font-mono text-card-foreground">{__COMMIT_HASH__}</span>
              
              <span className="text-muted-foreground flex items-center gap-1.5">
                <CalendarIcon size={14} /> Built At
              </span>
              <span className="text-card-foreground">{new Date(__BUILD_TIME__).toLocaleString()}</span>
            </div>
          </section>

          {/* Meeting Info */}
          <section className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              <TerminalIcon size={14} />
              Meeting Session
            </div>
            <div className="grid grid-cols-2 gap-y-1.5 text-sm">
              <span className="text-muted-foreground">Room ID</span>
              <span className="font-mono text-xs text-card-foreground truncate" title={roomId || undefined}>
                {roomId || "N/A"}
              </span>
              
              <span className="text-muted-foreground">Participant ID</span>
              <span className="font-mono text-xs text-card-foreground truncate" title={localParticipant?.id || undefined}>
                {localParticipant?.id || "N/A"}
              </span>
            </div>
          </section>

          {/* Auth Info */}
          <section className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              <ShieldCheckIcon size={14} />
              Authentication
            </div>
            <div className="grid grid-cols-2 gap-y-1.5 text-sm">
              <span className="text-muted-foreground">Status</span>
              <span className={cn("font-medium", authInfo.color)}>{authInfo.status}</span>
              
              <span className="text-muted-foreground">Expires In</span>
              <span className="text-card-foreground font-mono">
                {authInfo.remaining !== null ? formatRemaining(authInfo.remaining) : "N/A"}
              </span>
            </div>
          </section>

          {/* System */}
          <section className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              <MonitorIcon size={14} />
              System Specs
            </div>
            <div className="grid grid-cols-2 gap-y-1.5 text-sm">
              <span className="text-muted-foreground">OS / Browser</span>
              <span className="text-card-foreground">{systemInfo.os} / {systemInfo.browser}</span>
              
              <span className="text-muted-foreground">Screen</span>
              <span className="text-card-foreground">{systemInfo.screen} (@{systemInfo.dpr}x)</span>

              <span className="text-muted-foreground">Language</span>
              <span className="text-card-foreground">{systemInfo.lang}</span>
            </div>
          </section>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-border bg-muted/30 flex items-center justify-between gap-3">
          <button
            onClick={handleCopy}
            className={cn(
              "flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all",
              copied 
                ? "bg-green-500/10 text-green-500 border border-green-500/20" 
                : "bg-primary text-primary-foreground hover:opacity-90"
            )}
          >
            {copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
            {copied ? "Copied!" : "Copy Debug Bundle"}
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm font-medium border border-border hover:bg-muted transition-colors text-card-foreground"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
