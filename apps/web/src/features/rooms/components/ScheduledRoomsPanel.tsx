import type { ChalkSession, RoomResource } from "@q9labs/chalk-core";
import { AlertCircleIcon, Calendar01Icon, Clock01Icon, Share01Icon, Video01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { RefreshCcw } from "lucide-react";
import { GmailIcon } from "../../../components/GmailIcon";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Dialog, DialogClose, DialogContent } from "@q9labs/chalk-ui";
import { getPublicAppOrigin } from "../../../lib/publicUrl";

type ScheduledRoomsPanelProps = {
  client: Pick<ChalkSession, "scheduleRoom" | "createJoinToken">;
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

export function ScheduledRoomsPanel({ client, rooms, isLoading, error, onRefresh }: ScheduledRoomsPanelProps) {
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
      toast.error("Please enter a title for your room");
      return;
    }

    const startDate = new Date(startAtLocal);
    if (!Number.isFinite(startDate.getTime())) {
      toast.error("Please pick a starting date and time");
      return;
    }
    if (startDate.getTime() <= Date.now()) {
      toast.error("Room start time must be in the future");
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
      toast.success("Room successfully scheduled");
      setSessionName("");
      setStartAtLocal("");
      void onRefresh();
      setShowForm(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to schedule room");
    } finally {
      setIsCreating(false);
    }
  }

  async function copyInvite(room: RoomResource) {
    try {
      const response = await client.createJoinToken(room.id);
      const inviteUrl = `${getPublicAppOrigin()}/j/${response.joinToken}`;

      const timeStr = room.scheduledStartAt ? ` at ${new Date(room.scheduledStartAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}` : "";

      const message = `Join the room "${room.name || "Untitled Room"}"${timeStr}\n\nJoin link: ${inviteUrl}`;

      await navigator.clipboard.writeText(message);
      toast.success("Invitation link copied");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create invite link");
    }
  }

  async function sendGmailInvite(room: RoomResource) {
    try {
      const response = await client.createJoinToken(room.id);
      const inviteUrl = `${getPublicAppOrigin()}/j/${response.joinToken}`;

      const timeStr = room.scheduledStartAt ? new Date(room.scheduledStartAt).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" }) : "now";

      const subject = encodeURIComponent(`Invitation: ${room.name || "Chalk Room"}`);
      const body = encodeURIComponent(`Hi there,\n\nYou're invited to a Chalk room.\n\nTopic: ${room.name || "Untitled room"}\nTime: ${timeStr}\n\nJoin with Chalk\n${inviteUrl}\n\n—\nSent via Chalk`);

      window.open(`https://mail.google.com/mail/?view=cm&fs=1&tf=1&su=${subject}&body=${body}`, "_blank", "noopener,noreferrer");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create invite link");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between px-1">
        <div className="space-y-0.5">
          <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Scheduled Rooms</h3>
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="icon" onClick={() => void onRefresh()} className="h-7 w-7 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary/80">
            <RefreshCcw size={14} />
          </Button>
          <Button onClick={() => setShowForm(true)} variant="secondary" size="sm" className="h-7 px-3 text-xs font-bold rounded-lg border border-border/50 shadow-sm hover:border-border/80">
            New Room
          </Button>
        </div>
      </div>

      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="max-w-[480px] rounded-[2.5rem] border-white/10 shadow-[0_32px_64px_-12px_rgba(0,0,0,0.8)] p-0 overflow-hidden bg-[#030303] outline-none ring-0">
          <DialogClose className="absolute right-8 top-8 rounded-full p-2 text-white/30 hover:text-white hover:bg-white/5 transition-all outline-none" />
          
          <div className="px-10 pt-12 pb-8">
            <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center mb-6 border border-primary/20">
              <HugeiconsIcon icon={Calendar01Icon} className="text-primary" size={24} />
            </div>
            <h2 className="text-3xl font-bold tracking-tight text-white leading-tight">Schedule a Room</h2>
            <p className="text-base font-medium text-white/40 mt-2 leading-relaxed">
              Prepare a new live space and get an invite link for your team.
            </p>
          </div>

          <div className="px-10 pb-12 space-y-8">
            <div className="space-y-3">
              <label className="text-[11px] font-bold text-white/30 uppercase tracking-[0.15em] ml-1">Room Title</label>
              <Input 
                type="text" 
                autoComplete="off" 
                value={sessionName} 
                onChange={(e) => setSessionName(e.target.value)} 
                placeholder="e.g. Project Sync" 
                className="h-14 bg-white/[0.03] border-white/10 hover:border-white/20 focus-visible:ring-primary/30 rounded-2xl px-5 text-base font-medium transition-all text-white placeholder:text-white/20" 
              />
            </div>

            <div className="space-y-3">
              <label className="text-[11px] font-bold text-white/30 uppercase tracking-[0.15em] ml-1">Start Time</label>
              <Input 
                type="datetime-local" 
                value={startAtLocal} 
                onChange={(e) => setStartAtLocal(e.target.value)} 
                className="h-14 bg-white/[0.03] border-white/10 hover:border-white/20 focus-visible:ring-primary/30 block w-full rounded-2xl px-5 text-base font-medium transition-all text-white" 
                style={{ colorScheme: "dark" }} 
              />
            </div>

            <div className="grid grid-cols-2 gap-6">
              <div className="space-y-3">
                <label className="text-[11px] font-bold text-white/30 uppercase tracking-[0.15em] ml-1">Duration</label>
                <div className="relative group">
                  <Input 
                    type="number" 
                    min={1} 
                    value={durationMinutes} 
                    onChange={(e) => setDurationMinutes(e.target.value)} 
                    className="h-14 bg-white/[0.03] border-white/10 hover:border-white/20 focus-visible:ring-primary/30 rounded-2xl px-5 text-base font-medium transition-all text-white pr-14" 
                  />
                  <span className="absolute right-5 top-1/2 -translate-y-1/2 text-xs font-bold text-white/20 pointer-events-none group-focus-within:text-white/40">MIN</span>
                </div>
              </div>

              <div className="space-y-3">
                <label className="text-[11px] font-bold text-white/30 uppercase tracking-[0.15em] ml-1">Early Join</label>
                <div className="relative group">
                  <Input 
                    type="number" 
                    min={0} 
                    value={allowEarlyJoinMinutes} 
                    onChange={(e) => setAllowEarlyJoinMinutes(e.target.value)} 
                    className="h-14 bg-white/[0.03] border-white/10 hover:border-white/20 focus-visible:ring-primary/30 rounded-2xl px-5 text-base font-medium transition-all text-white pr-14" 
                  />
                  <span className="absolute right-5 top-1/2 -translate-y-1/2 text-xs font-bold text-white/20 pointer-events-none group-focus-within:text-white/40">MIN</span>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white/[0.02] border-t border-white/[0.05] px-10 py-8 flex items-center justify-between gap-4">
            <Button 
              variant="ghost" 
              onClick={() => setShowForm(false)} 
              className="font-bold h-12 px-8 rounded-2xl hover:bg-white/5 transition-colors text-white/40 hover:text-white"
            >
              Cancel
            </Button>
            <Button 
              disabled={isCreating} 
              onClick={() => void createScheduledSession()} 
              className="h-12 px-10 font-bold rounded-2xl shadow-[0_0_40px_rgba(27,182,166,0.2)] hover:scale-[1.02] active:scale-[0.98] transition-all bg-primary text-white hover:brightness-110"
            >
              {isCreating ? "Scheduling..." : "Schedule Room"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {error && (
        <div className="rounded-xl border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive flex items-center gap-3">
          <HugeiconsIcon icon={AlertCircleIcon} size={20} className="shrink-0" />
          <p className="font-medium">{error}</p>
        </div>
      )}

      {isLoading ? (
        <div className="grid grid-cols-1 gap-3">
          {[1, 2].map((i) => (
            <Card key={i} className="h-28 rounded-2xl border-border/50 bg-secondary/20 animate-pulse shadow-none" />
          ))}
        </div>
      ) : scheduledSessions.length === 0 ? (
        <div className="border border-dashed border-border/60 rounded-2xl p-8 text-center bg-secondary/10">
          <p className="text-xs text-muted-foreground font-medium">No scheduled rooms.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3">
          {scheduledSessions.map((room) => {
            const joinAllowedAtMs = toJoinAllowedAtMs(room);
            const isTooEarly = room.status === "scheduled" && joinAllowedAtMs !== null && nowMs < joinAllowedAtMs;
            const canEnter = room.status === "active" || (room.status === "scheduled" && !isTooEarly);

            return (
              <Card key={room.id} className="rounded-2xl border-border/50 bg-background shadow-sm hover:shadow-md hover:border-border/80 transition-all overflow-hidden group">
                <CardHeader className="p-4 pb-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <CardTitle className="text-sm font-bold truncate leading-tight">{room.name || `Room ${room.id.slice(0, 6)}`}</CardTitle>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-[11px] text-muted-foreground font-medium">
                        <span className="flex items-center gap-1">
                          <HugeiconsIcon icon={Calendar01Icon} size={12} />
                          {new Date(room.scheduledStartAt!).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                        </span>
                        <span className="flex items-center gap-1">
                          <HugeiconsIcon icon={Clock01Icon} size={12} />
                          Join {room.allowEarlyJoinMinutes ?? 0}m early
                        </span>
                      </div>
                    </div>
                    <Badge variant={room.status === "active" ? "default" : isTooEarly ? "secondary" : "outline"} className="rounded-md font-bold text-[9px] px-1.5 py-0 uppercase">
                      {room.status === "active" ? "LIVE" : isTooEarly ? "WAITING" : "OPEN"}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="p-4 pt-0 space-y-3">
                  <div className="flex items-center gap-2 pt-3 border-t border-border/40">
                    <Button variant="outline" size="sm" onClick={() => void copyInvite(room)} className="flex-1 h-8 rounded-lg font-semibold text-[11px] border-border/50 bg-background hover:bg-secondary">
                      <HugeiconsIcon icon={Share01Icon} size={12} className="mr-1.5" />
                      Copy Invite
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => void sendGmailInvite(room)} className="h-8 w-8 rounded-lg p-0 border-border/50 bg-background hover:bg-secondary shrink-0 flex items-center justify-center group/gmail" aria-label="Send invite via Gmail">
                      <GmailIcon size={14} className="group-hover/gmail:scale-110 transition-transform" />
                    </Button>
                    <Button disabled={!canEnter} onClick={() => window.open(`/room/${encodeURIComponent(room.id)}?auth=internal`, "_blank", "noopener,noreferrer")} size="sm" className="flex-1 h-8 rounded-lg font-bold text-[11px] shadow-sm hover:scale-[1.02] active:scale-[0.98] transition-all">
                      <HugeiconsIcon icon={Video01Icon} size={12} className="mr-1.5" />
                      {room.status === "active" ? "Join Now" : "Enter Room"}
                    </Button>
                  </div>
                  {isTooEarly && joinAllowedAtMs && <div className="text-[10px] font-bold text-orange-600 dark:text-orange-400 bg-orange-500/10 rounded-md p-1.5 text-center animate-pulse">Room opens in {toCountdown(joinAllowedAtMs, nowMs)}</div>}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
