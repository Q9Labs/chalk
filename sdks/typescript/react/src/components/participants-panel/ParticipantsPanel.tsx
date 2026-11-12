import { deviceHint } from "../../selectors/device-hint";
import { ChalkPopoverPrimitive as Popover } from "../chalk-ui";
import React, { useMemo, useState } from "react";
import { ChalkButton, ChalkPopover } from "../chalk-ui";
import { CallCardStyles } from "../call-card/CallCardStyles";
import { useCan, useParticipants, useSelf, useSpaceClient } from "../../bindings/hooks";
import { Cancel01Icon, Search01Icon } from "../../utils/icons";
import { useHandOrder } from "../../internal/useHandOrder";
import { handNumbers, orderParticipants } from "./participant-order";
import { matchParticipants } from "./participant-search";
import { cn } from "../../utils/cn";
import { AdmissionPanel } from "../admission-panel/AdmissionPanel";
import { ParticipantRow } from "./participant-row";
import { useParticipantVolumeContext } from "./participant-volume-context";
import { type ParticipantGradientPreference } from "../../utils/colorGenerator";

export interface ParticipantListParticipant {
  id: string;
  displayName: string;
  deviceHint?: string;
  role?: string;
  /** Whether the participant has the endEpisode capability. */
  isHost?: boolean;
  eligibleRoles?: readonly string[];
  isScreenSharing?: boolean;
  isLocal?: boolean;
  isMuted?: boolean;
  isVideoEnabled?: boolean;
  isHandRaised?: boolean;
  /** Place in the queue of raised hands, counting from 1. */
  handOrder?: number;
  isSpeaking?: boolean;
  isReconnecting?: boolean;
  avatarUrl?: string;
}

export type ParticipantListVariant = "default" | "sidebar" | "mobile";

export interface ParticipantsPanelProps {
  onParticipantClick?: (id: string) => void;
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
  /** Each raised hand's place in the queue. Without it the panel counts hands from when it mounted. */
  handOrders?: ReadonlyMap<string, number>;
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

function PeopleLabel({ text, count }: { readonly text: string; readonly count: number }) {
  return (
    <h3 className="call-people-section">
      {text} <span>{count}</span>
    </h3>
  );
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
    onParticipantClick,
    participantGradientPreference,
    generatedAvatars = true,
  }: ParticipantsPanelSurfaceProps) => {
    const [query, setQuery] = useState("");
    const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
    const [muting, setMuting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const searching = query.trim().length > 0;
    const found = matchParticipants(participants, query);
    const groups = orderParticipants(participants);
    const numbered = handNumbers(participants);
    const waitingBlock = canManageAdmission && admissionEnabled && admissionCount > 0;
    const labelled = participants.length > 8 || waitingBlock;
    const unmutedCount = participants.filter((person) => !person.isLocal && !person.isMuted).length;
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
    const row = (participant: ParticipantListParticipant) => (
      <ParticipantRow
        key={participant.id}
        participant={participant}
        query={searching ? query : ""}
        handNumber={numbered ? participant.handOrder : undefined}
        onParticipantClick={onParticipantClick}
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
    );
    return (
      <section className={cn("call-people", className)} aria-label="People">
        <CallCardStyles />
        {onMuteEveryone && participants.length > 1 ? (
          <div className="call-host-controls">
            <ChalkPopover label="Mute everyone" trigger={<ChalkButton disabled={muting || unmutedCount === 0}>Mute everyone</ChalkButton>}>
              <div className="call-mute-confirm">
                <b>Mute everyone?</b>
                <p>
                  {unmutedCount} {unmutedCount === 1 ? "person" : "people"} will be muted. They can unmute themselves.
                </p>
                <div className="call-mute-actions">
                  <Popover.Close render={<ChalkButton disabled={muting} />}>Cancel</Popover.Close>
                  <Popover.Close render={<ChalkButton variant="solid" disabled={muting} onClick={() => void muteEveryone()} />}>{muting ? "Muting…" : `Mute ${unmutedCount} ${unmutedCount === 1 ? "person" : "people"}`}</Popover.Close>
                </div>
              </div>
            </ChalkPopover>
          </div>
        ) : null}
        <div className="call-people-list">
          {error ? <p role="alert">{error}</p> : null}
          {searchable && (participants.length > 8 || query.length > 0) ? (
            <label className="call-people-search" data-active={searching || undefined}>
              <Search01Icon aria-hidden="true" />
              <input aria-label="Search people" placeholder="Search people" value={query} onChange={(event) => setQuery(event.target.value)} />
              {query ? (
                <button type="button" className="call-people-search-clear" aria-label="Clear search" onClick={() => setQuery("")}>
                  <Cancel01Icon aria-hidden="true" />
                </button>
              ) : null}
            </label>
          ) : null}
          {waitingBlock ? <AdmissionPanel inline /> : null}
          {searching ? (
            found.length ? (
              <>
                <div className="call-people-count" aria-live="polite">
                  {found.length} of {participants.length} people
                </div>
                {found.map((person) => row(person))}
              </>
            ) : (
              <p className="call-no-people">No one in the call matches “{query.trim()}”.</p>
            )
          ) : (
            <>
              {groups.you.map((person) => row(person))}
              {labelled && groups.hands.length ? <PeopleLabel text="Raised hands" count={groups.hands.length} /> : null}
              {groups.hands.map((person) => row(person))}
              {labelled && groups.others.length ? <PeopleLabel text="In the call" count={groups.others.length} /> : null}
              {groups.others.map((person) => row(person))}
            </>
          )}
        </div>
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
  const ownHandOrders = useHandOrder(useMemo(() => participantsSlice.roster.filter((participant) => participant.handRaised).map((participant) => participant.participantId), [participantsSlice.roster]));
  const handOrders = props.handOrders ?? ownHandOrders;
  const participants = useMemo(
    () =>
      participantsSlice.roster.map((participant) => ({
        id: participant.participantId,
        displayName: participant.displayName,
        deviceHint: deviceHint(participant, participantsSlice.roster),
        role: participant.role,
        isHost: participant.capabilities.includes("endEpisode"),
        eligibleRoles: participant.eligibleRoles,
        isScreenSharing: participant.media.screenShare === "active",
        isLocal: participant.participantId === self.participantId,
        isMuted: participant.media.microphone !== "active",
        isVideoEnabled: participant.media.camera === "active",
        isHandRaised: participant.handRaised,
        handOrder: handOrders.get(participant.participantId),
        isSpeaking: participant.presence.speaking,
        isReconnecting: participant.presence.state === "disconnected",
      })),
    [participantsSlice.roster, self.participantId, handOrders],
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
