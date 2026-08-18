import React, { useMemo, useState } from "react";
import { Badge, Button, IconButton, Input } from "@q9labsai/chalk-ui";
import { useCan, useParticipants, useSelf, useSpaceClient } from "../../bindings/hooks";
import { Cancel01Icon, Search01Icon, UserGroupIcon } from "../../utils/icons";
import { usePrefersReducedMotion } from "../../internal/useMediaQuery";
import { cn } from "../../utils/cn";
import { getParticipantThemeVariables } from "../../utils/colorGenerator";
import { ParticipantRow } from "./participant-row";
import { useParticipantVolumeContext } from "./participant-volume-context";
import type { ParticipantListParticipant, ParticipantsPanelProps } from "./ParticipantsPanel";

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
        <div className={cn("chalk-textured-surface relative flex h-full w-full flex-col overflow-hidden bg-[var(--chalk-app-panel)] font-sans", className)} style={themeVariables as React.CSSProperties} data-tour="participants-panel" role="complementary" aria-label="Participants list">
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

export const ClassicParticipantsPanel = React.memo((props: ParticipantsPanelProps): React.JSX.Element => {
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

ClassicParticipantsPanel.displayName = "ParticipantsPanel";
