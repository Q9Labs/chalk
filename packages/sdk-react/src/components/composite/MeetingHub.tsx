import React, { useState } from "react";
import { InformationCircleIcon, Copy01Icon, Tick01Icon, Link01Icon, Shield01Icon, Monitor01Icon, Cancel01Icon } from "../../utils/icons";
import { cn } from "../../utils/cn";

// Specialized Icons for Health
const PulseIcon = ({ className }: { className?: string }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
  </svg>
);

const SignalIcon = ({ className, strength = 4 }: { className?: string; strength?: number }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M2 20h.01" className={strength >= 1 ? "opacity-100" : "opacity-20"} />
    <path d="M7 20v-4" className={strength >= 2 ? "opacity-100" : "opacity-20"} />
    <path d="M12 20v-8" className={strength >= 3 ? "opacity-100" : "opacity-20"} />
    <path d="M17 20V8" className={strength >= 4 ? "opacity-100" : "opacity-20"} />
    <path d="M22 20V4" className={strength >= 5 ? "opacity-100" : "opacity-20"} />
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
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
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

    // Sync tab with recording state? No, keep it manual.

    const handleCopy = () => {
      onCopyLink();
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    };

    if (!isOpen) return null;

    return (
      <div className={cn("fixed bottom-24 left-6 z-50 w-[360px] overflow-hidden rounded-[28px] border border-white/10 bg-zinc-950/95 backdrop-blur-3xl shadow-[0_32px_64px_-16px_rgba(0,0,0,0.6)] animate-in fade-in slide-in-from-bottom-8 duration-500 ease-out", className)}>
        {/* Premium Header */}
        <div className="relative px-6 py-5 border-b border-white/5 bg-gradient-to-b from-white/[0.02] to-transparent">
          <div className="flex items-start justify-between">
            <div className="space-y-1">
              <div className="flex items-center gap-2.5">
                <h3 className="text-[17px] font-bold text-white tracking-tight">Meeting Hub</h3>
                {isRecording && (
                  <div className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-red-500/15 border border-red-500/30">
                    <div className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                    <span className="text-[9px] font-black text-red-500 uppercase tracking-[0.15em]">Recording</span>
                  </div>
                )}
                {isTranscribing && (
                  <div className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-blue-500/15 border border-blue-500/30">
                    <div className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
                    <span className="text-[9px] font-black text-blue-500 uppercase tracking-[0.15em]">Transcribing</span>
                  </div>
                )}
              </div>
              <p className="text-[11px] font-bold text-white/30 uppercase tracking-widest tabular-nums">Session Live • {formatDuration(meetingDuration)}</p>
            </div>
            <button type="button" onClick={onClose} className="rounded-full p-2.5 text-white/20 hover:bg-white/5 hover:text-white transition-all duration-300" aria-label="Close meeting hub">
              <Cancel01Icon size={20} />
            </button>
          </div>
        </div>

        {/* Segmented Control Tabs */}
        <div className="p-2">
          <div className="flex p-1 rounded-2xl bg-white/[0.03] border border-white/5" role="tablist" aria-label="Meeting hub sections">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "details"}
              onClick={() => setActiveTab("details")}
              className={cn("flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-[12px] font-bold rounded-xl transition-all duration-300", activeTab === "details" ? "bg-white/10 text-white shadow-[0_4px_12px_rgba(0,0,0,0.2)]" : "text-white/40 hover:text-white/60 hover:bg-white/5")}
            >
              <InformationCircleIcon size={14} />
              Details
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "health"}
              onClick={() => setActiveTab("health")}
              className={cn("flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-[12px] font-bold rounded-xl transition-all duration-300", activeTab === "health" ? "bg-white/10 text-white shadow-[0_4px_12px_rgba(0,0,0,0.2)]" : "text-white/40 hover:text-white/60 hover:bg-white/5")}
            >
              <PulseIcon className="w-3.5 h-3.5" />
              Health
            </button>
          </div>
        </div>

        {/* Dynamic Content Area */}
        <div className="px-6 py-5 min-h-[280px]">
          {activeTab === "details" ? (
            <div className="space-y-6 animate-in fade-in slide-in-from-left-4 duration-300">
              <div className="space-y-1.5">
                <label className="text-[10px] font-black uppercase tracking-[0.2em] text-white/20">Room Identity</label>
                <div className="flex items-end justify-between">
                  <p className="text-lg font-bold text-white leading-tight">{roomName}</p>
                  <div className="flex flex-col items-end">
                    <span className="text-[10px] font-bold text-white/40">{stats.version}</span>
                    <span className="text-[9px] font-bold text-white/10 uppercase tracking-widest">SDK Version</span>
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                <label className="text-[10px] font-black uppercase tracking-[0.2em] text-white/20">Access Information</label>
                <div className="group relative flex items-center gap-4 rounded-3xl border border-white/5 bg-white/[0.02] p-4 transition-all hover:border-white/10 hover:bg-white/[0.04]">
                  <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white/5 text-white/60 group-hover:text-white transition-colors">
                    <Link01Icon size={18} />
                  </div>
                  <div className="flex-1 overflow-hidden">
                    <p className="truncate text-xs font-bold text-white/60 group-hover:text-white/90 transition-colors">{meetingUrl}</p>
                  </div>
                  <button
                    type="button"
                    onClick={handleCopy}
                    className={cn("flex h-10 w-10 items-center justify-center rounded-2xl transition-all duration-500", copied ? "bg-green-500/20 text-green-400 scale-110" : "bg-white/5 text-white/30 hover:bg-white/10 hover:text-white")}
                    aria-label={copied ? "Meeting link copied" : "Copy meeting link"}
                    aria-live="polite"
                  >
                    {copied ? <Tick01Icon size={18} /> : <Copy01Icon size={18} />}
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-4 rounded-3xl bg-primary/5 p-4 border border-primary/10">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                  <Shield01Icon size={20} />
                </div>
                <div className="space-y-0.5">
                  <p className="text-[13px] font-bold text-white/90">End-to-End Secure</p>
                  <p className="text-[11px] font-medium text-white/30">Media streams are encrypted via RealtimeKit.</p>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-7 animate-in fade-in slide-in-from-right-4 duration-300">
              {/* Primary Stats */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-white/20">
                    <SignalIcon strength={5} className="text-green-500" />
                    <span className="text-[10px] font-black uppercase tracking-[0.15em]">Latency</span>
                  </div>
                  <p className="text-2xl font-bold text-white tabular-nums">
                    {stats.latency}
                    <span className="text-xs ml-1 text-white/30 font-bold uppercase">ms</span>
                  </p>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-white/20">
                    <Monitor01Icon size={14} className="text-blue-400" />
                    <span className="text-[10px] font-black uppercase tracking-[0.15em]">Stream</span>
                  </div>
                  <p className="text-[15px] font-bold text-white pt-1">{stats.resolution}</p>
                </div>
              </div>

              {/* Quality Visualization */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-white/30">
                    <div className="flex gap-0.5">
                      {[1, 2, 3, 4].map((i) => (
                        <div key={i} className={cn("w-1 h-3 rounded-full", i <= 3 ? "bg-green-500" : "bg-white/10")} />
                      ))}
                    </div>
                    <span className="text-[11px] font-bold uppercase tracking-widest text-white/40">Network Health</span>
                  </div>
                  <span className="text-[11px] font-black text-green-400 uppercase tracking-widest">Excellent</span>
                </div>

                <div className="space-y-2.5 rounded-3xl bg-white/[0.02] border border-white/5 p-4">
                  <div className="flex justify-between items-center text-[10px] font-bold uppercase tracking-wider">
                    <span className="text-white/20">Bitrate</span>
                    <span className="text-white/60">{stats.bitrate}</span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/5">
                    <div className="h-full w-[88%] bg-gradient-to-r from-primary to-blue-400 rounded-full" />
                  </div>
                  <div className="flex justify-between items-center text-[10px] font-bold uppercase tracking-wider pt-1">
                    <span className="text-white/20">Packet Loss</span>
                    <span className="text-white/60">{stats.packetLoss}%</span>
                  </div>
                </div>
              </div>

              {/* Infrastructure Details */}
              <div className="flex items-center justify-between px-2">
                <div className="flex items-center gap-3">
                  <div className="w-2 h-2 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]" />
                  <span className="text-[11px] font-bold text-white/40 uppercase tracking-widest">{stats.region}</span>
                </div>
                <span className="text-[9px] font-bold text-white/10 uppercase tracking-[0.2em]">P2P MESH</span>
              </div>
            </div>
          )}
        </div>

        {/* Refined Footer */}
        <div className="px-6 py-4 border-t border-white/5 bg-white/[0.01]">
          <div className="flex items-center justify-between opacity-20 hover:opacity-100 transition-opacity duration-500">
            <span className="text-[9px] font-black uppercase tracking-[0.3em] text-white">Chalk Cloud v2.4</span>
            <div className="flex gap-4">
              <div className="w-1.5 h-1.5 rounded-full bg-blue-500" />
              <div className="w-1.5 h-1.5 rounded-full bg-primary" />
              <div className="w-1.5 h-1.5 rounded-full bg-purple-500" />
            </div>
          </div>
        </div>
      </div>
    );
  },
);

MeetingHub.displayName = "MeetingHub";
