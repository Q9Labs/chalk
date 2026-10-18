import React, { useMemo, useState } from "react";
import { ChalkButton, ChalkPopover } from "../chalk-ui";
import { CallCardStyles } from "../call-card/CallCardStyles";
import { useCan, useParticipants, useSelf, useSpaceClient } from "../../bindings/hooks";
import { Search01Icon } from "../../utils/icons";
import { cn } from "../../utils/cn";
import { Avatar } from "../atomic/Avatar";
import { AdmissionPanel } from "../admission-panel/AdmissionPanel";
import { ParticipantRow } from "./participant-row";
import { useParticipantVolumeContext } from "./participant-volume-context";
import { type ParticipantGradientPreference } from "../../utils/colorGenerator";

export interface ParticipantListParticipant {
  id: string;
  displayName: string;
  role?: string;
  eligibleRoles?: readonly string[];
  isScreenSharing?: boolean;
  isLocal?: boolean;
  isMuted?: boolean;
  isVideoEnabled?: boolean;
  isHandRaised?: boolean;
  handOrder?: number;
  avatarUrl?: string;
}

export type ParticipantListVariant = "default" | "sidebar" | "mobile";

export interface ParticipantsPanelProps {
  onAddPeople?: () => void;
  searchable?: boolean;
  onClose?: () => void;
  /** Override the media request actions when the host surface owns command feedback. */
  onRequestUnmute?: (id: string) => void | Promise<unknown>;
  onRequestStartCamera?: (id: string) => void | Promise<unknown>;
  /** Receives a cleared value after a successful command and a message after a failed command. */
  onCommandError?: (message: string | null) => void;
  /** Per-participant volume overrides (0-100). Only contains adjusted participants. */
  participantVolumes?: ReadonlyMap<string, number>;
  /** Called when a participant's volume is changed via the slider. */
  onParticipantVolumeChange?: (id: string, volume: number) => void;
  participantColorSeed?: string;
  participantGradientPreference?: ParticipantGradientPreference;
  /** Show a generated Facehash when a Participant has no uploaded avatar. */
  generatedAvatars?: boolean;
  /** Show the capability-gated admission section when the Space enables it. */
  admissionEnabled?: boolean;
  className?: string;
  variant?: ParticipantListVariant;
  title?: string;
}

interface ParticipantsPanelSurfaceProps extends ParticipantsPanelProps {
  readonly participants: ParticipantListParticipant[];
  readonly onAssignRole?: (id: string, role: string) => Promise<unknown>;
  readonly onStopParticipantScreenShare?: (id: string) => Promise<unknown>;
  readonly onMuteParticipant?: (id: string) => void;
  readonly onRequestUnmute?: (id: string) => void | Promise<unknown>;
  readonly onStopParticipantCamera?: (id: string) => void;
  readonly onRequestStartCamera?: (id: string) => void | Promise<unknown>;
  readonly onRemoveParticipant?: (id: string) => void;
  readonly onUpdateDisplayName?: (name: string) => void;
  readonly onCommandError?: (message: string | null) => void;
  readonly canManageParticipants?: boolean;
  readonly canManageAdmission?: boolean;
  readonly admissionCount?: number;
  readonly onMuteEveryone?: () => Promise<void>;
}

export const ParticipantsPanelSurface = React.memo(
  ({
    participants,
    canManageParticipants = false,
    canManageAdmission = false,
    admissionCount = 0,
    admissionEnabled = true,
    onMuteEveryone,
    searchable = true,
    className,
    variant = "default",
    onAssignRole,
    onStopParticipantScreenShare,
    onMuteParticipant,
    onRequestUnmute,
    onStopParticipantCamera,
    onRequestStartCamera,
    onRemoveParticipant,
    onUpdateDisplayName,
    onCommandError,
    participantVolumes,
    onParticipantVolumeChange,
    participantGradientPreference,
    generatedAvatars = true,
  }: ParticipantsPanelSurfaceProps) => {
    const [query, setQuery] = useState("");
    const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
    const [muting, setMuting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const filtered = participants.filter((person) => person.displayName.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
    const raised = participants.filter((person) => person.isHandRaised);
    const muteEveryone = async () => {
      if (!onMuteEveryone || muting) return;
      setMuting(true);
      setError(null);
      try {
        await onMuteEveryone();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Couldn’t mute everyone.");
      } finally {
        setMuting(false);
      }
    };
    return (
      <section className={cn("call-people", className)} aria-label="People">
        <CallCardStyles />
        {canManageAdmission || onMuteEveryone ? (
          <div className="call-host-controls">
            {canManageAdmission ? (
              <button type="button" className="call-host-button" disabled title="Joining settings are unavailable">
                Who can join
              </button>
            ) : null}
            {onMuteEveryone ? (
              <ChalkPopover
                label="Mute everyone"
                trigger={
                  <button type="button" className="call-host-button" disabled={muting || !participants.some((person) => !person.isLocal && !person.isMuted)}>
                    Mute everyone
                  </button>
                }
              >
                <div className="call-mute-confirm">
                  <b>Mute everyone?</b>
                  <p>Everyone else’s microphone will turn off. They can unmute themselves.</p>
                  <ChalkButton disabled={muting} onClick={() => void muteEveryone()}>
                    {muting ? "Muting…" : "Mute everyone"}
                  </ChalkButton>
                </div>
              </ChalkPopover>
            ) : null}
          </div>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
        {searchable && (participants.length > 8 || query.length > 0) ? (
          <label className="call-people-search">
            <Search01Icon aria-hidden="true" />
            <input aria-label="Search people" placeholder="Search people" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
        ) : null}
        {canManageAdmission && admissionEnabled && admissionCount > 0 ? (
          <>
            <AdmissionPanel inline />
            <h3 className="call-people-section">In the call</h3>
          </>
        ) : null}
        {!query && raised.length > 1 ? (
          <>
            <h3 className="call-people-section">Raised hands</h3>
            {raised.map((person) => (
              <div className="call-raised-row" key={person.id}>
                {person.handOrder !== undefined ? <span className="call-hand-number">{person.handOrder}</span> : null}
                <Avatar name={person.displayName} src={person.avatarUrl} size="sm" generated={generatedAvatars} className="!h-8 !w-8" />
                <bdi className="min-w-0 flex-1 truncate">{person.displayName}</bdi>
              </div>
            ))}
            <h3 className="call-people-section">In the call</h3>
          </>
        ) : null}
        {filtered.length ? (
          filtered.map((participant) => (
            <ParticipantRow
              key={participant.id}
              participant={participant}
              variant={variant}
              canManageParticipants={canManageParticipants}
              onAssignRole={onAssignRole}
              onStopParticipantScreenShare={onStopParticipantScreenShare}
              onMuteParticipant={onMuteParticipant}
              onRequestUnmute={onRequestUnmute}
              onStopParticipantCamera={onStopParticipantCamera}
              onRequestStartCamera={onRequestStartCamera}
              onRemoveParticipant={onRemoveParticipant}
              onUpdateDisplayName={onUpdateDisplayName}
              onCommandError={onCommandError}
              participantVolumes={participantVolumes}
              onParticipantVolumeChange={onParticipantVolumeChange}
              participantGradientPreference={participant.isLocal ? participantGradientPreference : undefined}
              generatedAvatars={generatedAvatars}
              menuOpen={activeMenuId === participant.id}
              onMenuToggle={() => setActiveMenuId(activeMenuId === participant.id ? null : participant.id)}
              onMenuClose={() => setActiveMenuId(null)}
            />
          ))
        ) : (
          <p className="call-no-people">No one in the call matches “{query.trim()}”.</p>
        )}
      </section>
    );
  },
);

export const ParticipantsPanel = React.memo((props: ParticipantsPanelProps): React.JSX.Element => {
  const client = useSpaceClient();
  const self = useSelf();
  const participantsSlice = useParticipants();
  const canAssignRoles = useCan("assignRoles");
  const canStopScreenOthers = useCan("stopScreenOthers");
  const canMuteOthers = useCan("muteOthers");
  const canStopVideoOthers = useCan("stopVideoOthers");
  const canRequestMedia = useCan("requestMediaOthers");
  const canRemoveParticipants = useCan("removeParticipant");
  const canManageAdmission = useCan("manageAdmission");
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
        role: participant.role,
        eligibleRoles: participant.eligibleRoles,
        isScreenSharing: participant.media.screenShare === "active",
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
      canManageParticipants={canMuteOthers || canStopVideoOthers || canRequestMedia || canRemoveParticipants || canAssignRoles || canStopScreenOthers}
      onAssignRole={canAssignRoles ? (id, role) => client.participants.assignRole(id, role) : undefined}
      onStopParticipantScreenShare={canStopScreenOthers ? (id) => client.participants.stopScreenShare(id) : undefined}
      canManageAdmission={canManageAdmission}
      admissionCount={canManageAdmission ? participantsSlice.admissionQueue.length : 0}
      onMuteEveryone={
        canMuteOthers
          ? async () => {
              await Promise.all(participants.filter((person) => !person.isLocal && !person.isMuted).map((person) => client.participants.mute(person.id)));
            }
          : undefined
      }
      onMuteParticipant={canMuteOthers ? (id) => client.participants.mute(id) : undefined}
      onRequestUnmute={canRequestMedia ? (props.onRequestUnmute ?? ((id) => client.participants.requestMedia(id, "microphone"))) : undefined}
      onStopParticipantCamera={canStopVideoOthers ? (id) => client.participants.stopVideo(id) : undefined}
      onRequestStartCamera={canRequestMedia ? (props.onRequestStartCamera ?? ((id) => client.participants.requestMedia(id, "camera"))) : undefined}
      onRemoveParticipant={canRemoveParticipants ? (id) => client.participants.remove(id) : undefined}
      onUpdateDisplayName={(displayName) => void client.participants.renameSelf(displayName)}
      participantColorSeed={props.participantColorSeed ?? self.displayName ?? undefined}
    />
  );
});

ParticipantsPanel.displayName = "ParticipantsPanel";
