import type { ConferenceClient, RoomResource } from "@q9labs/chalk-core";
import { AlertCircleIcon, Calendar01Icon, Clock01Icon, Share01Icon, Video01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { RefreshCcw } from "lucide-react";
import { GmailIcon } from "../../../components/GmailIcon";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogClose } from "@q9labs/chalk-ui";

type ScheduledClassesPanelProps = {
  client: ConferenceClient;
  rooms: RoomResource[];
  isLoading: boolean;
  error: string | null;
  onRefresh: () => Promise<void>;
};

function toCountdown(targetMs: number, nowMs: number) {
  const remainingMs = Math.max(0, targetMs - nowMs);
  const totalSeconds = Math.floor(remainingMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function toSessionStartMs(room: RoomResource) {
  if (!room.scheduledStartAt) return null;
  const startMs = new Date(room.scheduledStartAt).getTime();
  return Number.isFinite(startMs) ? startMs : null;
}

function toJoinAllowedAtMs(room: RoomResource) {
  const startMs = toSessionStartMs(room);
  if (startMs === null) return null;
  const earlyJoinMs = Math.max(0, room.allowEarlyJoinMinutes ?? 0) * 60_000;
  return startMs - earlyJoinMs;
}

export function ScheduledClassesPanel({ client, rooms, isLoading, error, onRefresh }: ScheduledClassesPanelProps) {
  const [sessionName, setSessionName] = useState("");
  const [startAtLocal, setStartAtLocal] = useState("");
  const [durationMinutes, setDurationMinutes] = useState("60");
  const [allowEarlyJoinMinutes, setAllowEarlyJoinMinutes] = useState("10");
  const [isCreating, setIsCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [nowMs, setNowMs] = useState(Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const scheduledSessions = useMemo(() => {
    return [...rooms]
      .filter((room) => room.status === "scheduled" || room.status === "active")
      .sort((a, b) => {
        const aMs = toSessionStartMs(a) ?? new Date(a.createdAt).getTime();
        const bMs = toSessionStartMs(b) ?? new Date(b.createdAt).getTime();
        return aMs - bMs;
      });
  }, [rooms]);

  async function createScheduledSession() {
    const trimmedName = sessionName.trim();
    if (!trimmedName) {
      toast.error("Please enter a title for your session");
      return;
    }

    const startDate = new Date(startAtLocal);
    if (!Number.isFinite(startDate.getTime())) {
      toast.error("Please pick a starting date and time");
      return;
    }
    if (startDate.getTime() <= Date.now()) {
      toast.error("Session start time must be in the future");
      return;
    }

    const duration = Math.max(1, Number.parseInt(durationMinutes || "0", 10));
    const earlyJoin = Math.max(0, Number.parseInt(allowEarlyJoinMinutes || "0", 10));
    const scheduledEndAt = new Date(startDate.getTime() + duration * 60_000);

    setIsCreating(true);
    try {
      await client.scheduleRoom({
        name: trimmedName,
        scheduledStartAt: startDate.toISOString(),
        scheduledEndAt: scheduledEndAt.toISOString(),
        allowEarlyJoinMinutes: earlyJoin,
      });
      toast.success("Session successfully scheduled");
      setSessionName("");
      setStartAtLocal("");
      void onRefresh();
      setShowForm(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to schedule session");
    } finally {
      setIsCreating(false);
    }
  }

  async function copyInvite(room: RoomResource) {
    try {
      const response = await client.createJoinToken(room.id);
      const inviteUrl = `${window.location.origin}/j/${response.joinToken}`;

      const timeStr = room.scheduledStartAt ? ` at ${new Date(room.scheduledStartAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}` : "";

      const message = `Join the session "${room.name || "Untitled Session"}"${timeStr}\n\nJoin link: ${inviteUrl}`;

      await navigator.clipboard.writeText(message);
      toast.success("Invitation link copied");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create invite link");
    }
  }

  async function sendGmailInvite(room: RoomResource) {
    try {
      const response = await client.createJoinToken(room.id);
      const inviteUrl = `${window.location.origin}/j/${response.joinToken}`;

      const timeStr = room.scheduledStartAt ? new Date(room.scheduledStartAt).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" }) : "now";

      const subject = encodeURIComponent(`Invitation: ${room.name || "Chalk Session"}`);
      const body = encodeURIComponent(`Hi there,\n\nYou're invited to a Chalk session.\n\nTopic: ${room.name || "Untitled session"}\nTime: ${timeStr}\n\nJoin with Chalk\n${inviteUrl}\n\n—\nSent via Chalk`);

      window.open(`https://mail.google.com/mail/?view=cm&fs=1&tf=1&su=${subject}&body=${body}`, "_blank", "noopener,noreferrer");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create invite link");
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between px-1">
        <div className="space-y-0.5">
          <h3 className="text-lg font-bold tracking-tight text-foreground">Scheduled Sessions</h3>
          <p className="text-sm text-muted-foreground">Plan and manage your upcoming live sessions</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={() => void onRefresh()} className="h-9 w-9 rounded-lg">
            <RefreshCcw size={18} />
          </Button>
          <Button onClick={() => setShowForm(true)} variant="default" size="sm" className="h-9 font-semibold">
            New Session
          </Button>
        </div>
      </div>

      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="max-w-[500px]">
          <DialogClose />
          <DialogHeader>
            <DialogTitle>Schedule a New Session</DialogTitle>
            <DialogDescription>Fill in the details below to initialize your live session.</DialogDescription>
          </DialogHeader>

          <div className="p-6 pt-0 space-y-5">
            <div className="space-y-2">
              <label className="text-[13px] font-bold text-foreground pl-0.5">Session Title</label>
              <Input type="text" autoComplete="off" value={sessionName} onChange={(e) => setSessionName(e.target.value)} placeholder="e.g. Team Standup" className="h-11 border-border focus-visible:ring-primary/20" />
            </div>

            <div className="space-y-2">
              <label className="text-[13px] font-bold text-foreground pl-0.5">Start Date & Time</label>
              <Input type="datetime-local" value={startAtLocal} onChange={(e) => setStartAtLocal(e.target.value)} className="h-11 border-border focus-visible:ring-primary/20 block" />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-[13px] font-bold text-foreground pl-0.5">Duration (mins)</label>
                <Input type="number" min={1} value={durationMinutes} onChange={(e) => setDurationMinutes(e.target.value)} className="h-11 border-border focus-visible:ring-primary/20" />
              </div>

              <div className="space-y-2">
                <label className="text-[13px] font-bold text-foreground pl-0.5">Early Join (mins)</label>
                <Input type="number" min={0} value={allowEarlyJoinMinutes} onChange={(e) => setAllowEarlyJoinMinutes(e.target.value)} className="h-11 border-border focus-visible:ring-primary/20" />
              </div>
            </div>
          </div>

          <DialogFooter className="bg-muted/30 border-t border-border mt-2">
            <Button variant="ghost" onClick={() => setShowForm(false)} className="font-semibold">
              Cancel
            </Button>
            <Button disabled={isCreating} onClick={() => void createScheduledSession()} className="h-10 px-8 font-black shadow-lg shadow-primary/20">
              {isCreating ? "Scheduling..." : "Create Session"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {error && (
        <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-4 text-sm text-destructive flex items-center gap-3">
          <HugeiconsIcon icon={AlertCircleIcon} size={20} className="shrink-0" />
          <p className="font-medium">{error}</p>
        </div>
      )}

      {isLoading ? (
        <div className="grid grid-cols-1 gap-4">
          {[1, 2].map((i) => (
            <Card key={i} className="h-32 border-border/50 bg-muted/20 animate-pulse shadow-none" />
          ))}
        </div>
      ) : scheduledSessions.length === 0 ? (
        <div className="border border-dashed border-border rounded-xl p-12 text-center bg-muted/10">
          <p className="text-sm text-muted-foreground font-medium italic">No sessions scheduled. Create one to get started.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {scheduledSessions.map((room) => {
            const joinAllowedAtMs = toJoinAllowedAtMs(room);
            const isTooEarly = room.status === "scheduled" && joinAllowedAtMs !== null && nowMs < joinAllowedAtMs;
            const canEnter = room.status === "active" || (room.status === "scheduled" && !isTooEarly);

            return (
              <Card key={room.id} className="border-border shadow-sm hover:border-primary/30 transition-all overflow-hidden group">
                <CardHeader className="p-5 pb-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <CardTitle className="text-[15px] font-bold truncate">{room.name || `Session ${room.id.slice(0, 6)}`}</CardTitle>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1.5 text-[12px] text-muted-foreground font-medium">
                        <span className="flex items-center gap-1.5">
                          <HugeiconsIcon icon={Calendar01Icon} size={14} />
                          {new Date(room.scheduledStartAt!).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                        </span>
                        <span className="flex items-center gap-1.5">
                          <HugeiconsIcon icon={Clock01Icon} size={14} />
                          Join {room.allowEarlyJoinMinutes ?? 0}m early
                        </span>
                      </div>
                    </div>
                    <Badge variant={room.status === "active" ? "default" : isTooEarly ? "secondary" : "outline"} className="rounded-md font-bold text-[10px] h-5 px-1.5">
                      {room.status === "active" ? "LIVE" : isTooEarly ? "WAITING" : "OPEN"}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="p-5 pt-0 space-y-4">
                  <div className="flex items-center gap-2 pt-2 border-t border-border/50">
                    <Button variant="outline" size="sm" onClick={() => void copyInvite(room)} className="flex-1 h-9 font-semibold text-xs border-border hover:bg-muted">
                      <HugeiconsIcon icon={Share01Icon} size={14} className="mr-1.5" />
                      Copy Invite
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => void sendGmailInvite(room)} className="h-9 w-9 p-0 border-border hover:bg-muted shrink-0 flex items-center justify-center group/gmail" aria-label="Send invite via Gmail">
                      <GmailIcon size={16} className="group-hover/gmail:scale-110 transition-transform" />
                    </Button>
                    <Button disabled={!canEnter} onClick={() => window.open(`/room/${encodeURIComponent(room.id)}?auth=internal`, "_blank", "noopener,noreferrer")} size="sm" className="flex-1 h-9 font-bold text-xs">
                      <HugeiconsIcon icon={Video01Icon} size={14} className="mr-1.5" />
                      {room.status === "active" ? "Join Now" : "Enter Room"}
                    </Button>
                  </div>
                  {isTooEarly && joinAllowedAtMs && <div className="text-[11px] font-semibold text-orange-600 dark:text-orange-400 bg-orange-500/5 border border-orange-500/10 rounded-md p-2 text-center animate-pulse">Session opens in {toCountdown(joinAllowedAtMs, nowMs)}</div>}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
