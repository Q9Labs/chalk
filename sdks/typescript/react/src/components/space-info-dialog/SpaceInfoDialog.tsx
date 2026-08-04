import React, { useState } from "react";

import { cn } from "../../utils/cn";
import { Cancel01Icon, Copy01Icon, Monitor01Icon, Shield01Icon, Tick01Icon } from "../../utils/icons";

export interface SpaceInfoDialogProps {
  isOpen: boolean;
  onClose: () => void;
  spaceName: string;
  spaceId?: string;
  inviteLink: string;
  onCopyLink: () => void;
  isRecording?: boolean;
  isTranscribing?: boolean;
  duration?: number;
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

export const SpaceInfoDialog = React.memo<SpaceInfoDialogProps>(({ isOpen, onClose, spaceName, spaceId, inviteLink, onCopyLink, isRecording = false, isTranscribing = false, duration = 0, stats = { latency: 28, packetLoss: 0.1, resolution: "1080p · 60fps", region: "Frankfurt, DE" }, className }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    onCopyLink();
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2_000);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[var(--chalk-stage)] p-4 backdrop-blur-[1px]" onMouseDown={onClose}>
      <section
        className={cn("w-full max-w-[500px] overflow-hidden rounded-[14px] border border-[var(--chalk-line)] bg-[var(--chalk-surface)] text-[var(--chalk-text)] shadow-[var(--chalk-shadow)]", className)}
        role="dialog"
        aria-modal="true"
        aria-label="Space details"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-5 border-b border-[var(--chalk-line)] px-6 py-5">
          <div className="min-w-0">
            <h2 className="text-xl font-semibold tracking-[-0.025em]">Space details</h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-[var(--chalk-muted-text)]">
              <span className="truncate">{spaceName}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">{formatDuration(duration)}</span>
              {isRecording ? <span className="rounded-full bg-[var(--chalk-danger-surface)] px-2 py-0.5 text-[var(--chalk-danger)]">Recording</span> : null}
              {isTranscribing ? <span className="rounded-full bg-[var(--chalk-danger-surface)] px-2 py-0.5 text-[var(--chalk-accent)]">Transcribing</span> : null}
            </div>
          </div>
          <button type="button" onClick={onClose} className="grid h-9 w-9 shrink-0 place-items-center rounded-[8px] text-[var(--chalk-muted-text)] transition hover:bg-[var(--chalk-stage)] hover:text-[var(--chalk-text)]" aria-label="Close space details">
            <Cancel01Icon size={19} />
          </button>
        </header>

        <div className="space-y-5 p-6">
          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-semibold">Invite link</p>
              {spaceId ? <p className="font-mono text-[11px] text-[var(--chalk-muted-text)]">ID {spaceId}</p> : null}
            </div>
            <div className="flex items-center gap-2 rounded-[10px] border border-[var(--chalk-line)] bg-[var(--chalk-surface)] p-2">
              <p className="min-w-0 flex-1 truncate px-2 font-mono text-xs text-[var(--chalk-muted-text)]">{inviteLink}</p>
              <button
                type="button"
                onClick={handleCopy}
                className={cn("flex h-9 shrink-0 items-center gap-2 rounded-[7px] px-3 text-xs font-semibold transition", copied ? "bg-[var(--chalk-positive)] text-[var(--chalk-accent)]" : "bg-[var(--chalk-text)] !text-[var(--chalk-accent-text)] hover:bg-[var(--chalk-text)]")}
                aria-label={copied ? "Space link copied" : "Copy space link"}
                aria-live="polite"
              >
                {copied ? <Tick01Icon size={15} /> : <Copy01Icon size={15} />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>

          <div className="grid overflow-hidden rounded-[10px] border border-[var(--chalk-line)] bg-[var(--chalk-surface)] sm:grid-cols-2">
            <div className="border-b border-[var(--chalk-line)] p-4 sm:border-b-0 sm:border-r">
              <div className="flex items-center gap-2 text-[var(--chalk-accent)]">
                <Shield01Icon size={17} />
                <span className="text-sm font-semibold">Media protected</span>
              </div>
              <p className="mt-2 text-xs leading-5 text-[var(--chalk-muted-text)]">Streams are encrypted in transit through the configured provider.</p>
            </div>
            <div className="p-4">
              <div className="flex items-center gap-2">
                <Monitor01Icon size={17} />
                <span className="text-sm font-semibold">Connection</span>
              </div>
              <p className="mt-2 text-xs leading-5 text-[var(--chalk-muted-text)]">
                {stats.resolution} · {stats.latency} ms · {stats.packetLoss}% loss
              </p>
              <p className="mt-1 truncate text-[11px] text-[var(--chalk-muted-text)]">{stats.region}</p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
});

SpaceInfoDialog.displayName = "SpaceInfoDialog";
