import { Input } from "@q9labs/chalk-ui";
import { Search01Icon, Calendar01Icon, Clock01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { ScheduledRoomsPanel } from "../../rooms/components/ScheduledRoomsPanel";
import { cn } from "../../../lib/utils";
import type { Meeting } from "../types";
import { formatDuration } from "../utils";

interface DashboardSidebarProps {
  meetings: Meeting[];
  search: string;
  onSearchChange: (value: string) => void;
  selectedId: string | null;
  onSelectMeeting: (id: string) => void;

  // Scheduled Rooms
  sdkClient: any;
  scheduledRooms: any[];
  roomsLoading: boolean;
  roomsError: string | null;
  onRefreshRooms: () => Promise<void>;
}

export function DashboardSidebar({ meetings, search, onSearchChange, selectedId, onSelectMeeting, sdkClient, scheduledRooms, roomsLoading, roomsError, onRefreshRooms }: DashboardSidebarProps) {
  const filteredMeetings = meetings.filter((m) => (m.room_name || "").toLowerCase().includes(search.toLowerCase()));

  return (
    <aside className="w-full md:w-80 lg:w-96 flex-shrink-0 flex flex-col border-r border-border/40 bg-secondary/10 h-[calc(100vh-4rem)] overflow-y-auto scrollbar-hide">
      <div className="p-6 space-y-8">
        {/* Search */}
        <div className="relative w-full group">
          <HugeiconsIcon icon={Search01Icon} size={16} aria-hidden="true" className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground group-focus-within:text-primary transition-colors" />
          <Input placeholder="Search rooms..." className="h-10 bg-background border-border/50 pl-10 rounded-xl shadow-sm focus-visible:ring-primary/20 text-foreground placeholder:text-muted-foreground" value={search} onChange={(e) => onSearchChange(e.target.value)} aria-label="Search rooms" />
        </div>

        <ScheduledRoomsPanel client={sdkClient} rooms={scheduledRooms} isLoading={roomsLoading} error={roomsError} onRefresh={onRefreshRooms} />

        <div className="space-y-4">
          <div className="flex items-center justify-between px-1">
            <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Recent Rooms</h3>
            <span className="font-mono text-[10px] px-2 py-0.5 rounded-full bg-secondary border border-border/50 text-muted-foreground font-bold">{filteredMeetings.length}</span>
          </div>
          <div className="space-y-2">
            {filteredMeetings.map((m) => {
              const isActive = selectedId === m.id;
              return (
                <button
                  key={m.id}
                  onClick={() => onSelectMeeting(m.id)}
                  className={cn("w-full text-left p-4 rounded-xl transition-all outline-none focus-visible:ring-2 focus-visible:ring-primary group border", isActive ? "bg-background border-border/60 shadow-sm" : "bg-transparent border-transparent hover:bg-secondary/50")}
                >
                  <div className="flex flex-col gap-2 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <h4 className={cn("font-semibold text-sm leading-tight truncate flex-1", isActive ? "text-foreground" : "text-foreground/80 group-hover:text-foreground")}>{m.room_name || `Untitled Room`}</h4>
                      {m.status === "ready" && <div className={cn("w-1.5 h-1.5 rounded-full shrink-0 mt-1", isActive ? "bg-primary" : "bg-muted-foreground/30")} />}
                    </div>
                    <div className="flex items-center gap-4 text-xs font-medium text-muted-foreground tracking-tight">
                      <span className="flex items-center gap-1.5 min-w-0 truncate">
                        <HugeiconsIcon icon={Calendar01Icon} size={14} className="opacity-70" />
                        {new Date(m.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                      </span>
                      <span className="flex items-center gap-1.5 shrink-0">
                        <HugeiconsIcon icon={Clock01Icon} size={14} className="opacity-70" />
                        {formatDuration(m.duration_seconds || 0)}
                      </span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </aside>
  );
}
