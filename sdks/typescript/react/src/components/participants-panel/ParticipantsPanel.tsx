import React, { useMemo, useState } from "react";
import { useCan, useParticipants, useSelf, useSpaceClient } from "../../bindings/hooks";
import { Cancel01Icon, Search01Icon, UserGroupIcon } from "../../utils/icons";
import { usePrefersReducedMotion } from "../../internal/useMediaQuery";
import { cn } from "../../utils/cn";
import { getParticipantThemeVariables, type ParticipantGradientPreference } from "../../utils/colorGenerator";
import { ChalkBadge, ChalkButton, ChalkChrome, ChalkEmptyState, ChalkIconButton, ChalkInput, ChalkPanel } from "../chalk-ui";
import { useSkin } from "../skin-context";
import { ClassicParticipantsPanel } from "./ClassicParticipantsPanel";
import { ParticipantRow } from "./participant-row";
import { useParticipantVolumeContext } from "./participant-volume-context";

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
  onAddPeople?: () => void;
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

interface ParticipantsPanelSurfaceProps extends ParticipantsPanelProps {
  readonly participants: ParticipantListParticipant[];
  readonly onMuteParticipant?: (id: string) => void;
  readonly onRequestUnmute?: (id: string) => void;
  readonly onStopParticipantCamera?: (id: string) => void;
  readonly onRequestStartCamera?: (id: string) => void;
  readonly onRemoveParticipant?: (id: string) => void;
  readonly onUpdateDisplayName?: (name: string) => void;
  readonly canManageParticipants?: boolean;
}

function getParticipantIdentity(participant: ParticipantListParticipant): string {
  return participant.id || participant.displayName || "__unknown-participant__";
}

const ParticipantsPanelSurface = React.memo(
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
  }: ParticipantsPanelSurfaceProps) => {
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

    const listSpacingClassName = "space-y-1";

    const rows = (
      <div className={listSpacingClassName}>
        {filteredParticipants.length === 0 ? (
          <ChalkEmptyState className="p-8 text-sm text-[var(--chalk-app-text-muted)]" title="No participants found" />
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
        <ChalkPanel className={cn("relative flex h-full w-full flex-col overflow-hidden bg-[var(--chalk-app-panel)] p-0 font-sans", className)} style={themeVariables as React.CSSProperties} data-tour="participants-panel" role="complementary" aria-label="Participants list">
          <div className="flex-1 overflow-y-auto px-4 py-4">
            {onAddPeople && (
              <ChalkButton variant="solid" tone="accent" onClick={onAddPeople} className="mb-4 min-h-[48px] w-full rounded-full px-4 py-3 !text-[var(--chalk-app-control-active-text)]">
                <UserGroupIcon className="w-4 h-4" />
                <span>Add people</span>
              </ChalkButton>
            )}

            {/* Section Label */}
            <div className="mb-3 px-1">
              <p className="text-[var(--chalk-app-text-muted)] text-[10px] font-semibold uppercase tracking-[0.1em]">IN THIS SPACE ({participants.length})</p>
            </div>

            {/* Participants List */}
            {rows}
          </div>
        </ChalkPanel>
      );
    }

    if (variant === "sidebar") {
      return (
        <ChalkPanel className={cn("relative flex h-full w-full flex-col overflow-hidden bg-[var(--chalk-app-panel)] p-0 font-sans", className)} style={themeVariables as React.CSSProperties} data-tour="participants-panel" role="complementary" aria-label="Participants list">
          <header className="group relative flex items-center justify-between px-5 py-[18px]">
            <ChalkChrome className="absolute inset-0 h-full w-full" filled fill="var(--chalk-surface, var(--chalk-app-panel))" part="participants-header" />
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-semibold tracking-[-0.025em] text-[var(--chalk-app-text)]">{title === "Participants" ? "People" : title}</h2>
              <ChalkBadge count={participants.length} className="min-w-6 rounded-full px-1.5 py-0.5 text-xs text-[var(--chalk-app-text-muted)]" />
            </div>

            <div className="flex items-center gap-2">
              {onAddPeople && (
                <ChalkButton variant="solid" tone="accent" onClick={onAddPeople} className="h-9 gap-1.5 rounded-[7px] px-3 text-sm font-semibold !text-[var(--chalk-app-control-active-text)]">
                  <UserGroupIcon className="w-4 h-4" />
                  <span>Invite</span>
                </ChalkButton>
              )}
              {onClose && (
                <ChalkIconButton type="button" size="sm" onClick={onClose} className="rounded-full text-[var(--chalk-app-text-muted)]" aria-label="Close">
                  <Cancel01Icon className="w-5 h-5" />
                </ChalkIconButton>
              )}
            </div>
          </header>

          {searchable && (
            <div className="px-5 py-4">
              <div className="relative">
                <Search01Icon className="pointer-events-none absolute left-3 top-1/2 z-[2] h-4 w-4 -translate-y-1/2 text-[var(--chalk-app-text-muted)]" />
                <ChalkInput placeholder="Search people" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} wrapperClassName="w-full" className="w-full rounded-[7px] bg-[var(--chalk-app-input)] pl-9 transition-all placeholder:text-[var(--chalk-app-text-muted)]" />
              </div>
            </div>
          )}

          <div className="flex-1 overflow-y-auto px-5 pb-5">{rows}</div>
        </ChalkPanel>
      );
    }

    // Default rendering (preserving exact existing structure/classes)
    return (
      <ChalkPanel
        className={cn("flex h-full w-80 flex-col overflow-hidden bg-[var(--chalk-app-panel)] p-0 shadow-xl", !prefersReducedMotion && "chalk-animate-slide-right", className)}
        style={themeVariables as React.CSSProperties}
        data-tour="participants-panel"
        role="complementary"
        aria-label="Participants list"
      >
        <header className="group relative flex items-center justify-between p-4">
          <ChalkChrome className="absolute inset-0 h-full w-full" filled fill="var(--chalk-surface, var(--chalk-app-panel))" part="participants-header" />
          <div className="flex items-center gap-2">
            <h2 className="text-[var(--chalk-app-text)] text-sm font-semibold">{title}</h2>
            <ChalkBadge count={participants.length} />
          </div>
          {onClose && (
            <ChalkIconButton size="sm" onClick={onClose} aria-label="Close participant list">
              <Cancel01Icon className="w-4 h-4" />
            </ChalkIconButton>
          )}
        </header>

        {searchable && (
          <div className="p-4 pb-2">
            <div className="relative">
              <Search01Icon className="pointer-events-none absolute left-3 top-1/2 z-[2] h-4 w-4 -translate-y-1/2" />
              <ChalkInput placeholder="Search participants..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} wrapperClassName="w-full" className="w-full pl-9" />
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-2">{rows}</div>
      </ChalkPanel>
    );
  },
);

const ChalkParticipantsPanel = React.memo((props: ParticipantsPanelProps): React.JSX.Element => {
  const client = useSpaceClient();
  const self = useSelf();
  const participantsSlice = useParticipants();
  const canMuteOthers = useCan("muteOthers");
  const canStopVideoOthers = useCan("stopVideoOthers");
  const canRequestMedia = useCan("requestMediaOthers");
  const canRemoveParticipants = useCan("removeParticipant");
  const contextVolumeState = useParticipantVolumeContext();
  const [localVolumes, setLocalVolumes] = useState<ReadonlyMap<string, number>>(new Map());
  const isControlled = props.participantVolumes !== undefined && props.onParticipantVolumeChange !== undefined;
  const participantVolumes = isControlled ? props.participantVolumes : (contextVolumeState?.volumes ?? localVolumes);
  const onParticipantVolumeChange = isControlled
    ? props.onParticipantVolumeChange
    : (contextVolumeState?.setVolume ??
      ((participantId, volume) =>
        setLocalVolumes((current) => {
          const next = new Map(current);
          if (volume === 100) next.delete(participantId);
          else next.set(participantId, volume);
          return next;
        })));
  const participants = useMemo(
    () =>
      participantsSlice.roster.map((participant) => ({
        id: participant.participantId,
        displayName: participant.displayName,
        isLocal: participant.participantId === self.participantId,
        isMuted: participant.media.microphone !== "active",
        isVideoEnabled: participant.media.camera === "active",
        isHandRaised: participant.handRaised,
      })),
    [participantsSlice.roster, self.participantId],
  );

  return (
    <ParticipantsPanelSurface
      {...props}
      participantVolumes={participantVolumes}
      onParticipantVolumeChange={onParticipantVolumeChange}
      participants={participants}
      canManageParticipants={canMuteOthers || canStopVideoOthers || canRequestMedia || canRemoveParticipants}
      onMuteParticipant={canMuteOthers ? (id) => void client.participants.mute(id) : undefined}
      onRequestUnmute={canRequestMedia ? (id) => void client.participants.requestMedia(id, "microphone") : undefined}
      onStopParticipantCamera={canStopVideoOthers ? (id) => void client.participants.stopVideo(id) : undefined}
      onRequestStartCamera={canRequestMedia ? (id) => void client.participants.requestMedia(id, "camera") : undefined}
      onRemoveParticipant={canRemoveParticipants ? (id) => void client.participants.remove(id) : undefined}
      onUpdateDisplayName={(displayName) => void client.participants.renameSelf(displayName)}
      participantColorSeed={props.participantColorSeed ?? self.displayName ?? undefined}
    />
  );
});

export const ParticipantsPanel = React.memo((props: ParticipantsPanelProps): React.JSX.Element => {
  const skin = useSkin();
  return skin === "classic" ? <ClassicParticipantsPanel {...props} /> : <ChalkParticipantsPanel {...props} />;
});

ParticipantsPanel.displayName = "ParticipantsPanel";
