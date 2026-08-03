import React, { useState } from "react";

import { cn } from "../../utils/cn";
import { Cancel01Icon, Copy01Icon, Monitor01Icon, Shield01Icon, Tick01Icon } from "../../utils/icons";

export interface ConferenceInfoDialogProps {
  isOpen: boolean;
  onClose: () => void;
  roomName: string;
  meetingId?: string;
  meetingUrl: string;
  onCopyLink: () => void;
  isRecording?: boolean;
  isTranscribing?: boolean;
  meetingDuration?: number;
  stats?: {
    latency?: number;
    packetLoss?: number;
    bitrate?: string;
    resolution?: string;
    region?: string;
    version?: string;
  };
  className?: string;
}

const formatDuration = (seconds: number): string => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${remainingSeconds.toString().padStart(2, "0")}`;
};

export const ConferenceInfoDialog = React.memo<ConferenceInfoDialogProps>(
  ({ isOpen, onClose, roomName, meetingId, meetingUrl, onCopyLink, isRecording = false, isTranscribing = false, meetingDuration = 0, stats = { latency: 28, packetLoss: 0.1, resolution: "1080p · 60fps", region: "Frankfurt, DE" }, className }) => {
    const [copied, setCopied] = useState(false);

    const handleCopy = () => {
      onCopyLink();
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    };

    if (!isOpen) return null;

    return (
      <div className="fixed inset-0 z-50 grid place-items-center bg-black/20 p-4 backdrop-blur-[1px]" onMouseDown={onClose}>
        <section
          className={cn("chalk-textured-surface w-full max-w-[500px] overflow-hidden rounded-[14px] border border-[var(--chalk-app-line-strong)] bg-[var(--chalk-app-panel)] text-[var(--chalk-app-text)] shadow-[var(--chalk-app-shadow-sm)]", className)}
          role="dialog"
          aria-modal="true"
          aria-label="Meeting details"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <header className="flex items-start justify-between gap-5 border-b border-[var(--chalk-app-line)] px-6 py-5">
            <div className="min-w-0">
              <h2 className="text-xl font-semibold tracking-[-0.025em]">Meeting details</h2>
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-[var(--chalk-app-text-muted)]">
                <span className="truncate">{roomName}</span>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums">{formatDuration(meetingDuration)}</span>
                {isRecording ? <span className="rounded-full bg-[#f8e4e4] px-2 py-0.5 text-[#9f3f3f]">Recording</span> : null}
                {isTranscribing ? <span className="rounded-full bg-[#e5f3f8] px-2 py-0.5 text-[#315f72]">Transcribing</span> : null}
              </div>
            </div>
            <button type="button" onClick={onClose} className="grid h-9 w-9 shrink-0 place-items-center rounded-[8px] text-[var(--chalk-app-text-muted)] transition hover:bg-[var(--chalk-app-control-hover)] hover:text-[var(--chalk-app-text)]" aria-label="Close meeting details">
              <Cancel01Icon size={19} />
            </button>
          </header>

          <div className="space-y-5 p-6">
            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-semibold">Invite link</p>
                {meetingId ? <p className="font-mono text-[11px] text-[var(--chalk-app-text-muted)]">ID {meetingId}</p> : null}
              </div>
              <div className="flex items-center gap-2 rounded-[10px] border border-[var(--chalk-app-line)] bg-[var(--chalk-app-input)] p-2">
                <p className="min-w-0 flex-1 truncate px-2 font-mono text-xs text-[var(--chalk-app-text-muted)]">{meetingUrl}</p>
                <button
                  type="button"
                  onClick={handleCopy}
                  className={cn("flex h-9 shrink-0 items-center gap-2 rounded-[7px] px-3 text-xs font-semibold transition", copied ? "bg-[#e3eadf] text-[#49645d]" : "bg-[var(--chalk-app-control-primary)] !text-white hover:bg-[var(--chalk-app-control-primary-hover)]")}
                  aria-label={copied ? "Meeting link copied" : "Copy meeting link"}
                  aria-live="polite"
                >
                  {copied ? <Tick01Icon size={15} /> : <Copy01Icon size={15} />}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            </div>

            <div className="grid overflow-hidden rounded-[10px] border border-[var(--chalk-app-line)] bg-[var(--chalk-app-control)] sm:grid-cols-2">
              <div className="border-b border-[var(--chalk-app-line)] p-4 sm:border-b-0 sm:border-r">
                <div className="flex items-center gap-2 text-[#49645d]">
                  <Shield01Icon size={17} />
                  <span className="text-sm font-semibold">Media protected</span>
                </div>
                <p className="mt-2 text-xs leading-5 text-[var(--chalk-app-text-muted)]">Streams are encrypted in transit through the configured provider.</p>
              </div>
              <div className="p-4">
                <div className="flex items-center gap-2">
                  <Monitor01Icon size={17} />
                  <span className="text-sm font-semibold">Connection</span>
                </div>
                <p className="mt-2 text-xs leading-5 text-[var(--chalk-app-text-muted)]">
                  {stats.resolution} · {stats.latency} ms · {stats.packetLoss}% loss
                </p>
                <p className="mt-1 truncate text-[11px] text-[var(--chalk-app-text-muted)]">{stats.region}</p>
              </div>
            </div>
          </div>
        </section>
      </div>
    );
  },
);

ConferenceInfoDialog.displayName = "ConferenceInfoDialog";
