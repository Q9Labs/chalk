import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "@q9labs/chalk-ui";
import { Share01Icon, Download01Icon, Calendar01Icon, Clock01Icon, Database01Icon, File02Icon, CheckmarkCircle01Icon, Video01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Loader2 } from "lucide-react";
import { ChalkLoader } from "../../../components/ChalkLoader";
import { VideoPlayer } from "../../../components/VideoPlayer";
import type { Meeting } from "../types";
import { formatDuration, formatBytes } from "../utils";
import { useState } from "react";
import { cn } from "../../../lib/utils";

interface DashboardDetailProps {
  meeting: Meeting | null;
  recordingUrl: string | null;
  isFetchingVideo: boolean;
  videoError: string | null;
  token: string;
  onShare: (id: string, token: string) => void;
  onDownload: (id: string, token: string) => void;
}

export function DashboardDetail({
  meeting, recordingUrl, isFetchingVideo, videoError, token, onShare, onDownload
}: DashboardDetailProps) {
  const [activeTab, setActiveTab] = useState<"intelligence" | "details">("intelligence");

  if (!meeting) {
    return (
      <div className="h-full flex items-center justify-center p-10 text-center">
        <div className="max-w-md space-y-6 animate-in fade-in zoom-in-95 duration-500">
          <div className="mx-auto w-20 h-20 rounded-2xl bg-secondary/50 flex items-center justify-center mb-6">
            <HugeiconsIcon icon={Video01Icon} size={32} className="text-muted-foreground" />
          </div>
          <h3 className="text-xl font-bold tracking-tight text-foreground">Select a Recording</h3>
          <p className="text-sm font-medium text-muted-foreground leading-relaxed text-balance">
            Choose a session from the timeline to view playback, read the AI summary, and review action items.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 md:p-8 lg:p-10 max-w-6xl mx-auto animate-in fade-in slide-in-from-right-4 duration-500 space-y-8">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <Badge variant={meeting.status === "ready" ? "default" : "secondary"} className="rounded-md font-bold text-[10px] tracking-wider px-2 py-0.5 uppercase">
              {meeting.status}
            </Badge>
            <span className="text-xs font-medium text-muted-foreground">ID: {meeting.id.split('-')[0]}</span>
          </div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground text-balance">
            {meeting.room_name || "Untitled Room"}
          </h1>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Button
            size="sm"
            variant="outline"
            disabled={meeting.status !== "ready"}
            onClick={() => onShare(meeting.id, token)}
            className="font-semibold rounded-lg text-sm bg-background hover:bg-secondary transition-colors"
          >
            <HugeiconsIcon icon={Share01Icon} size={16} className="mr-2" /> Share
          </Button>
          <Button
            size="sm"
            disabled={meeting.status !== "ready"}
            onClick={() => onDownload(meeting.id, token)}
            className="font-semibold rounded-lg text-sm shadow-sm hover:scale-[1.02] active:scale-[0.98] transition-all"
          >
            <HugeiconsIcon icon={Download01Icon} size={16} className="mr-2" /> Download
          </Button>
        </div>
      </div>

      {/* Video Player */}
      <div className="w-full">
        <div className="bg-secondary/20 border border-border/50 shadow-sm overflow-hidden flex flex-col rounded-[1.5rem]">
          {isFetchingVideo ? (
            <div className="w-full aspect-video flex flex-col items-center justify-center bg-secondary/10">
              <ChalkLoader size={40} />
              <p className="text-xs font-medium text-muted-foreground mt-4 animate-pulse tracking-wide">Loading Playback...</p>
            </div>
          ) : videoError ? (
            <div className="w-full aspect-video flex flex-col items-center justify-center p-8 text-center bg-secondary/30">
              <div className="w-12 h-12 rounded-xl bg-background border border-border/50 flex items-center justify-center mb-4">
                <HugeiconsIcon icon={Video01Icon} size={24} className="text-muted-foreground" />
              </div>
              <p className="text-base font-bold text-foreground">Video Unavailable</p>
              <p className="text-sm text-muted-foreground mt-1 max-w-xs">{videoError}</p>
            </div>
          ) : recordingUrl ? (
            <div className="w-full aspect-video bg-black relative">
              <VideoPlayer url={recordingUrl} className="w-full h-full rounded-none border-0" />
            </div>
          ) : null}
        </div>
      </div>

      {/* Details & Intelligence (Custom Tabs) */}
      <div className="w-full">
        <div className="flex items-center border-b border-border/50 gap-6 mb-6">
          <button
            onClick={() => setActiveTab("intelligence")}
            className={cn(
              "px-0 py-3 border-b-2 text-sm font-semibold transition-colors outline-none",
              activeTab === "intelligence" ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            Intelligence
          </button>
          <button
            onClick={() => setActiveTab("details")}
            className={cn(
              "px-0 py-3 border-b-2 text-sm font-semibold transition-colors outline-none",
              activeTab === "details" ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            Session Details
          </button>
        </div>

        {activeTab === "intelligence" && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 animate-in fade-in duration-300">
            {/* Summary */}
            <Card className="rounded-[1rem] border-border/50 shadow-sm bg-background">
              <CardHeader className="p-6 pb-3">
                <div className="flex items-center gap-2">
                  <HugeiconsIcon icon={File02Icon} size={18} className="text-primary" />
                  <CardTitle className="text-sm font-bold tracking-tight text-foreground">Session Summary</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="p-6 pt-0">
                <p className="text-sm font-medium text-muted-foreground leading-relaxed text-pretty">
                  {meeting.transcript_summary ? (
                    meeting.transcript_summary
                  ) : meeting.transcript_status === "failed" ? (
                    <span className="text-destructive/80">
                      {meeting.transcript_error_message || "Summary generation failed."}
                    </span>
                  ) : meeting.transcript_status === "completed" ? (
                    <span className="italic">No summary generated.</span>
                  ) : (
                    <span className="flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                      Synthesizing context...
                    </span>
                  )}
                </p>
              </CardContent>
            </Card>

            {/* Action Items */}
            <Card className="rounded-[1rem] border-border/50 shadow-sm bg-background flex flex-col">
              <CardHeader className="p-6 pb-3">
                <div className="flex items-center gap-2">
                  <HugeiconsIcon icon={CheckmarkCircle01Icon} size={18} className="text-primary" />
                  <CardTitle className="text-sm font-bold tracking-tight text-foreground">Action Items</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="p-0 flex-1 overflow-hidden">
                <div className="flex flex-col">
                  {meeting.transcript_action_items && meeting.transcript_action_items.length > 0 ? (
                    meeting.transcript_action_items.map((item, idx) => (
                      <div key={idx} className="p-4 border-t border-border/30 first:border-0 flex gap-3 hover:bg-secondary/30 transition-colors">
                        <span className="w-5 h-5 rounded bg-secondary text-muted-foreground flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5">{idx + 1}</span>
                        <span className="text-sm font-medium text-foreground leading-snug">{item}</span>
                      </div>
                    ))
                  ) : (
                    <div className="p-8 text-center flex flex-col items-center justify-center h-full opacity-60">
                      <HugeiconsIcon icon={CheckmarkCircle01Icon} size={24} className="text-muted-foreground mb-2" />
                      <p className="text-xs font-semibold text-muted-foreground">
                        {meeting.transcript_status === "completed" ? "No Actions Found" : "Pending..."}
                      </p>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {activeTab === "details" && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 animate-in fade-in duration-300">
            {[
              { label: "Date", val: new Date(meeting.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }), icon: Calendar01Icon },
              { label: "Time", val: new Date(meeting.created_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }), icon: Clock01Icon },
              { label: "Duration", val: formatDuration(meeting.duration_seconds || 0), icon: Video01Icon },
              { label: "Size", val: formatBytes(meeting.size_bytes || 0), icon: Database01Icon },
            ].map((item, i) => (
              <div key={i} className="bg-background border border-border/50 rounded-xl p-4 flex flex-col gap-3">
                <div className="w-8 h-8 rounded-lg bg-secondary flex items-center justify-center">
                  <HugeiconsIcon icon={item.icon} size={16} className="text-muted-foreground" />
                </div>
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-0.5">{item.label}</p>
                  <p className="text-sm font-semibold text-foreground truncate">{item.val}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
