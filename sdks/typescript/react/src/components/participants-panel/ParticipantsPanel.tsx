import React, { useMemo, useState } from "react";
import { Cancel01Icon, Search01Icon, UserGroupIcon } from "../../utils/icons";
import { IconButton } from "../atomic";
import { Badge } from "../atomic/Badge";
import { Input } from "../atomic/Input";
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
        if (a.isLocal) return -1;
        if (b.isLocal) return 1;

        return a.displayName.localeCompare(b.displayName);
      });

      if (searchQuery) {
        sorted = sorted.filter((p) => p.displayName.toLowerCase().includes(searchQuery.toLowerCase()));
      }

      return sorted;
    }, [participants, searchQuery]);

    const listSpacingClassName = variant === "sidebar" ? "divide-y divide-[var(--chalk-app-line)]" : "space-y-1";
    const emptyTextClassName = "text-[var(--chalk-app-text-muted)]";

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

    // Mobile variant - fills container, no header (the parent provides it)
    if (variant === "mobile") {
      return (
        <div className={cn("chalk-textured-surface relative flex h-full w-full flex-col overflow-hidden bg-[var(--chalk-app-panel)] font-sans", className)} style={themeVariables as React.CSSProperties} data-tour="participants-panel" role="complementary" aria-label="Participants list">
          <div className="flex-1 overflow-y-auto px-4 py-4">
            {onAddPeople && (
              <Button onClick={onAddPeople} className="mb-4 min-h-[48px] w-full rounded-full bg-[var(--chalk-app-control-primary)] px-4 py-3 !text-white shadow-[var(--chalk-app-shadow-control)] hover:bg-[var(--chalk-app-control-primary-hover)]">
                <UserGroupIcon className="w-4 h-4" />
                <span>Add people</span>
              </Button>
            )}

            {/* Section Label */}
            <div className="mb-3 px-1">
              <p className="text-[var(--chalk-app-text-muted)] text-[10px] font-semibold uppercase tracking-[0.1em]">IN THIS SPACE ({participants.length})</p>
            </div>

            {/* Participants List */}
            {rows}
          </div>
        </div>
      );
    }

    if (variant === "sidebar") {
      return (
        <div
          className={cn("chalk-textured-surface relative flex h-full w-full flex-col overflow-hidden bg-[var(--chalk-app-panel)] font-sans", !prefersReducedMotion && "chalk-animate-slide-right", className)}
          style={themeVariables as React.CSSProperties}
          data-tour="participants-panel"
          role="complementary"
          aria-label="Participants list"
        >
          <div className="flex items-center justify-between border-b border-[var(--chalk-app-line)] px-5 py-[18px]">
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-semibold tracking-[-0.025em] text-[var(--chalk-app-text)]">{title === "Participants" ? "People" : title}</h2>
              <span className="grid min-w-6 place-items-center rounded-full bg-[var(--chalk-app-control-group)] px-1.5 py-0.5 text-xs font-semibold text-[var(--chalk-app-text-muted)]">{participants.length}</span>
            </div>

            <div className="flex items-center gap-2">
              {onAddPeople && (
                <Button onClick={onAddPeople} className="h-9 gap-1.5 rounded-[7px] border-0 bg-[var(--chalk-app-control-primary)] px-3 text-sm font-semibold !text-white transition-colors hover:bg-[var(--chalk-app-control-primary-hover)]">
                  <UserGroupIcon className="w-4 h-4" />
                  <span>Invite</span>
                </Button>
              )}
              {onClose && (
                <button type="button" onClick={onClose} className="grid h-9 w-9 place-items-center rounded-full border border-[var(--chalk-app-line)] text-[var(--chalk-app-text-muted)] transition-colors hover:bg-[var(--chalk-app-control-hover)] hover:text-[var(--chalk-app-text)]" aria-label="Close">
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
                icon={<Search01Icon className="h-4 w-4 text-[var(--chalk-app-text-muted)]" />}
                iconPosition="left"
                className="w-full rounded-[7px] border-[var(--chalk-app-line)] bg-[var(--chalk-app-input)] transition-all placeholder:text-[var(--chalk-app-text-muted)] focus:border-[var(--chalk-app-control-active-line)] focus:bg-[var(--chalk-app-panel)]"
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
        className={cn("chalk-textured-surface flex h-full w-80 flex-col border-l border-[var(--chalk-app-line)] bg-[var(--chalk-app-panel)] shadow-xl", !prefersReducedMotion && "chalk-animate-slide-right", className)}
        style={themeVariables as React.CSSProperties}
        data-tour="participants-panel"
        role="complementary"
        aria-label="Participants list"
      >
        <div className="flex items-center justify-between border-b border-[var(--chalk-app-line)] p-4">
          <div className="flex items-center gap-2">
            <h2 className="text-[var(--chalk-app-text)] text-sm font-semibold">{title}</h2>
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
