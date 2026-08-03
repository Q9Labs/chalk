import React, { useMemo, useState } from "react";
import { Cancel01Icon, Search01Icon, UserGroupIcon } from "../../utils/icons";
import { Badge, IconButton, Input } from "../atomic";
import { Button } from "@q9labsai/chalk-ui";
import { usePrefersReducedMotion } from "../../internal/useMediaQuery";
import { cn } from "../../utils/cn";
import { getParticipantThemeVariables, type ParticipantGradientPreference } from "../../utils/colorGenerator";
import { ParticipantRow } from "./participant-row";

export interface ParticipantListParticipant {
  id: string;
  displayName: string;
  isLocal?: boolean;
  isMuted?: boolean;
  isVideoEnabled?: boolean;
  isHandRaised?: boolean;
  role?: "host" | "co-host" | "participant";
  avatarUrl?: string;
}

export type ParticipantListVariant = "default" | "sidebar" | "mobile";

export interface ParticipantsPanelProps {
  participants: ParticipantListParticipant[];
  onMuteParticipant?: (id: string) => void;
  onRequestUnmute?: (id: string) => void;
  onStopParticipantCamera?: (id: string) => void;
  onRequestStartCamera?: (id: string) => void;
  onRemoveParticipant?: (id: string) => void;
  onMakeHost?: (id: string) => void;
  onMakeCoHost?: (id: string) => void;
  onUpdateDisplayName?: (name: string) => void;
  onAddPeople?: () => void;
  canManageParticipants?: boolean;
  searchable?: boolean;
  onClose?: () => void;
  /** Per-participant volume overrides (0-100). Only contains adjusted participants. */
  participantVolumes?: ReadonlyMap<string, number>;
  /** Called when a participant's volume is changed via the slider. */
  onParticipantVolumeChange?: (id: string, volume: number) => void;
  participantColorSeed?: string;
  participantGradientPreference?: ParticipantGradientPreference;
  className?: string;
  variant?: ParticipantListVariant;
  title?: string;
}

function getParticipantIdentity(participant: ParticipantListParticipant): string {
  return participant.id || participant.displayName || "__unknown-participant__";
}

export const ParticipantsPanel = React.memo(
  ({
    participants,
    onMuteParticipant,
    onRequestUnmute,
    onStopParticipantCamera,
    onRequestStartCamera,
    onRemoveParticipant,
    onMakeHost,
    onMakeCoHost,
    onUpdateDisplayName,
    onAddPeople,
    participantVolumes,
    onParticipantVolumeChange,
    participantColorSeed,
    participantGradientPreference,
    canManageParticipants = false,
    searchable = true,
    onClose,
    className,
    variant = "default",
    title = "Participants",
  }: ParticipantsPanelProps) => {
    const prefersReducedMotion = usePrefersReducedMotion();
    const [searchQuery, setSearchQuery] = useState("");
    const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
    const themeVariables = useMemo(() => getParticipantThemeVariables(participantColorSeed, participantGradientPreference), [participantColorSeed, participantGradientPreference]);

    const filteredParticipants = useMemo(() => {
      const uniqueParticipants = Array.from(new Map(participants.map((participant) => [getParticipantIdentity(participant), participant])).values());

      let sorted = [...uniqueParticipants].sort((a, b) => {
        const aScore = a.role === "host" ? 2 : a.role === "co-host" ? 1 : 0;
        const bScore = b.role === "host" ? 2 : b.role === "co-host" ? 1 : 0;

        if (aScore !== bScore) return bScore - aScore;

        if (a.isLocal) return -1;
        if (b.isLocal) return 1;

        return a.displayName.localeCompare(b.displayName);
      });

      if (searchQuery) {
        sorted = sorted.filter((p) => p.displayName.toLowerCase().includes(searchQuery.toLowerCase()));
      }

      return sorted;
    }, [participants, searchQuery]);

    const listSpacingClassName = variant === "sidebar" ? "divide-y divide-[#ecebe6]" : "space-y-1";
    const emptyTextClassName = variant === "default" ? "text-chalk-text-muted" : "text-muted-foreground";

    const rows = (
      <div className={listSpacingClassName}>
        {filteredParticipants.length === 0 ? (
          <div className={cn("p-8 text-center text-sm", emptyTextClassName)}>No participants found</div>
        ) : (
          filteredParticipants.map((participant) => (
            <ParticipantRow
              key={getParticipantIdentity(participant)}
              participant={participant}
              variant={variant}
              canManageParticipants={canManageParticipants}
              onMuteParticipant={onMuteParticipant}
              onRequestUnmute={onRequestUnmute}
              onStopParticipantCamera={onStopParticipantCamera}
              onRequestStartCamera={onRequestStartCamera}
              onRemoveParticipant={onRemoveParticipant}
              onMakeHost={onMakeHost}
              onMakeCoHost={onMakeCoHost}
              onUpdateDisplayName={onUpdateDisplayName}
              participantVolumes={participantVolumes}
              onParticipantVolumeChange={onParticipantVolumeChange}
              participantGradientPreference={participant.isLocal ? participantGradientPreference : undefined}
              menuOpen={activeMenuId === participant.id}
              onMenuToggle={() => setActiveMenuId((prev) => (prev === participant.id ? null : participant.id))}
              onMenuClose={() => setActiveMenuId(null)}
            />
          ))
        )}
      </div>
    );

    // Mobile variant - fills container, no header (MobilePanel provides it)
    if (variant === "mobile") {
      return (
        <div className={cn("flex flex-col h-full w-full overflow-hidden font-sans relative bg-card", className)} style={themeVariables as React.CSSProperties} data-tour="participants-panel" role="complementary" aria-label="Participants list">
          <div className="flex-1 overflow-y-auto px-4 py-4">
            {onAddPeople && (
              <Button onClick={onAddPeople} className="w-full bg-primary hover:bg-primary/90 text-primary-foreground rounded-full py-3 px-4 mb-4 shadow-lg shadow-primary/25 min-h-[48px]">
                <UserGroupIcon className="w-4 h-4" />
                <span>Add people</span>
              </Button>
            )}

            {/* Section Label */}
            <div className="mb-3 px-1">
              <p className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground font-semibold">IN THE MEETING ({participants.length})</p>
            </div>

            {/* Participants List */}
            {rows}
          </div>
        </div>
      );
    }

    if (variant === "sidebar") {
      return (
        <div className={cn("relative flex h-full w-full flex-col overflow-hidden bg-white font-sans", !prefersReducedMotion && "chalk-animate-slide-right", className)} style={themeVariables as React.CSSProperties} data-tour="participants-panel" role="complementary" aria-label="Participants list">
          <div className="flex items-center justify-between border-b border-[#deddd7] px-5 py-[18px]">
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-semibold tracking-[-0.025em] text-[#0c0e12]">{title === "Participants" ? "People" : title}</h2>
              <span className="grid min-w-6 place-items-center rounded-full bg-[#eeede8] px-1.5 py-0.5 text-xs font-semibold text-[#555b65]">{participants.length}</span>
            </div>

            <div className="flex items-center gap-2">
              {onAddPeople && (
                <Button onClick={onAddPeople} className="h-9 gap-1.5 rounded-[7px] border-0 bg-[#202329] px-3 text-sm font-semibold !text-white transition-colors hover:bg-[#343840]">
                  <UserGroupIcon className="w-4 h-4" />
                  <span>Invite</span>
                </Button>
              )}
              {onClose && (
                <button type="button" onClick={onClose} className="grid h-9 w-9 place-items-center rounded-full border border-[#deddd7] text-[#555b65] transition-colors hover:bg-[#f7f6f2] hover:text-[#0c0e12]" aria-label="Close">
                  <Cancel01Icon className="w-5 h-5" />
                </button>
              )}
            </div>
          </div>

          {searchable && (
            <div className="px-5 py-4">
              <Input
                placeholder="Search people"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                icon={<Search01Icon className="w-4 h-4 text-[#858a92]" />}
                iconPosition="left"
                className="w-full rounded-[7px] border-[#deddd7] bg-[#fbfaf7] transition-all placeholder:text-[#858a92] focus:border-[#9dcfe1] focus:bg-white"
              />
            </div>
          )}

          <div className="flex-1 overflow-y-auto px-5 pb-5">{rows}</div>
        </div>
      );
    }

    // Default rendering (preserving exact existing structure/classes)
    return (
      <div
        className={cn("flex flex-col h-full bg-chalk-bg-surface border-l border-chalk-border-subtle w-80 shadow-xl", !prefersReducedMotion && "chalk-animate-slide-right", className)}
        style={themeVariables as React.CSSProperties}
        data-tour="participants-panel"
        role="complementary"
        aria-label="Participants list"
      >
        <div className="flex items-center justify-between p-4 border-b border-chalk-border-subtle">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-chalk-text-primary">{title}</h2>
            <Badge variant="default" count={participants.length} />
          </div>
          {onClose && <IconButton icon={<Cancel01Icon className="w-4 h-4" />} size="sm" variant="ghost" onClick={onClose} aria-label="Close participant list" />}
        </div>

        {searchable && (
          <div className="p-4 pb-2">
            <Input placeholder="Search participants..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} icon={<Search01Icon className="w-4 h-4" />} iconPosition="left" className="w-full" />
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-2">{rows}</div>
      </div>
    );
  },
);

ParticipantsPanel.displayName = "ParticipantsPanel";
