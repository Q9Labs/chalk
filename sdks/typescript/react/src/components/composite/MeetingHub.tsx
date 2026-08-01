import React, { useState } from "react";

import { cn } from "../../utils/cn";
import { Cancel01Icon, Copy01Icon, InformationCircleIcon, Monitor01Icon, Shield01Icon, Tick01Icon } from "../../utils/icons";

const PulseIcon = ({ className }: { readonly className?: string }) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
  </svg>
);

export interface MeetingHubProps {
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
  if (hours > 0) return `${hours}:${minutes.toString().padStart(2, "0")}:${remainingSeconds.toString().padStart(2, "0")}`;
  return `${minutes.toString().padStart(2, "0")}:${remainingSeconds.toString().padStart(2, "0")}`;
};

export const MeetingHub = React.memo<MeetingHubProps>(
  ({
    isOpen,
    onClose,
    roomName,
    meetingUrl,
    onCopyLink,
    isRecording = false,
    isTranscribing = false,
    meetingDuration = 0,
    stats = {
      latency: 28,
      packetLoss: 0.1,
      bitrate: "4.2 Mbps",
      resolution: "1080p • 60fps",
      region: "Frankfurt, DE (fra-1)",
      version: "v0.0.74",
    },
    className,
  }) => {
    const [activeTab, setActiveTab] = useState<"details" | "health">("details");
    const [copied, setCopied] = useState(false);

    const handleCopy = () => {
      onCopyLink();
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    };

    if (!isOpen) return null;

    return (
      <div className={cn("fixed bottom-[92px] left-1/2 z-50 w-[min(92vw,420px)] -translate-x-1/2 overflow-hidden rounded-[12px] border border-[#c9c8c2] bg-white text-[#0c0e12] shadow-[0_22px_60px_rgba(12,14,18,0.18)]", className)} role="dialog" aria-label="Meeting details">
        <header className="flex items-start justify-between gap-5 border-b border-[#deddd7] px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-xl font-semibold tracking-[-0.025em]">Meeting details</h2>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#858a92]">
              <span className="truncate">{roomName}</span>
              <span className="font-mono tabular-nums">{formatDuration(meetingDuration)}</span>
              {isRecording ? <span className="text-[#b94c4c]">Recording</span> : null}
              {isTranscribing ? <span className="text-[#315f72]">Transcribing</span> : null}
            </div>
          </div>
          <button type="button" onClick={onClose} className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-[#deddd7] text-[#555b65] transition hover:bg-[#f7f6f2] hover:text-[#0c0e12]" aria-label="Close meeting details">
            <Cancel01Icon size={19} />
          </button>
        </header>

        <div className="flex border-b border-[#deddd7] px-5" role="tablist" aria-label="Meeting detail sections">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "details"}
            onClick={() => setActiveTab("details")}
            className={cn("flex items-center gap-2 border-b-2 px-1 py-3 text-sm font-semibold transition", activeTab === "details" ? "border-[#202329] text-[#202329]" : "border-transparent text-[#858a92] hover:text-[#555b65]")}
          >
            <InformationCircleIcon size={16} />
            Details
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "health"}
            onClick={() => setActiveTab("health")}
            className={cn("ml-6 flex items-center gap-2 border-b-2 px-1 py-3 text-sm font-semibold transition", activeTab === "health" ? "border-[#202329] text-[#202329]" : "border-transparent text-[#858a92] hover:text-[#555b65]")}
          >
            <PulseIcon />
            Connection
          </button>
        </div>

        <div className="min-h-[225px] p-5">
          {activeTab === "details" ? (
            <div className="space-y-5">
              <div>
                <p className="text-sm font-medium text-[#555b65]">Join link</p>
                <div className="mt-2 flex items-center gap-2 rounded-[8px] border border-[#deddd7] bg-[#fbfaf7] p-2">
                  <p className="min-w-0 flex-1 truncate px-2 font-mono text-xs text-[#555b65]">{meetingUrl}</p>
                  <button
                    type="button"
                    onClick={handleCopy}
                    className={cn("flex h-9 shrink-0 items-center gap-2 rounded-[6px] px-3 text-xs font-semibold transition", copied ? "bg-[#e3eadf] text-[#49645d]" : "bg-[#202329] !text-white hover:bg-[#343840]")}
                    aria-label={copied ? "Meeting link copied" : "Copy meeting link"}
                    aria-live="polite"
                  >
                    {copied ? <Tick01Icon size={15} /> : <Copy01Icon size={15} />}
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>

              <div className="flex items-start gap-3 rounded-[8px] border border-[#d7e4d4] bg-[#f2f7f0] p-4">
                <Shield01Icon size={19} className="mt-0.5 shrink-0 text-[#49645d]" />
                <div>
                  <p className="text-sm font-semibold">Secure media</p>
                  <p className="mt-1 text-xs leading-5 text-[#555b65]">Media streams are encrypted in transit through the configured provider.</p>
                </div>
              </div>
            </div>
          ) : (
            <dl className="divide-y divide-[#e5e4df] border-y border-[#e5e4df]">
              <div className="flex items-center justify-between gap-4 py-3.5">
                <dt className="flex items-center gap-2 text-sm text-[#555b65]">
                  <PulseIcon className="text-[#49645d]" />
                  Latency
                </dt>
                <dd className="font-mono text-sm font-semibold">{stats.latency} ms</dd>
              </div>
              <div className="flex items-center justify-between gap-4 py-3.5">
                <dt className="flex items-center gap-2 text-sm text-[#555b65]">
                  <Monitor01Icon size={16} />
                  Stream
                </dt>
                <dd className="text-sm font-semibold">{stats.resolution}</dd>
              </div>
              <div className="flex items-center justify-between gap-4 py-3.5">
                <dt className="text-sm text-[#555b65]">Bitrate</dt>
                <dd className="font-mono text-sm">{stats.bitrate}</dd>
              </div>
              <div className="flex items-center justify-between gap-4 py-3.5">
                <dt className="text-sm text-[#555b65]">Packet loss</dt>
                <dd className="font-mono text-sm">{stats.packetLoss}%</dd>
              </div>
              <div className="flex items-center justify-between gap-4 py-3.5">
                <dt className="text-sm text-[#555b65]">Region</dt>
                <dd className="max-w-[230px] truncate text-sm">{stats.region}</dd>
              </div>
              <div className="flex items-center justify-between gap-4 py-3.5">
                <dt className="text-sm text-[#555b65]">SDK</dt>
                <dd className="font-mono text-sm">{stats.version}</dd>
              </div>
            </dl>
          )}
        </div>
      </div>
    );
  },
);

MeetingHub.displayName = "MeetingHub";
