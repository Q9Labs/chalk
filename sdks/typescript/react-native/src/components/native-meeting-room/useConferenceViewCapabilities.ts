import type { ChalkSessionSnapshot, ChalkSessionStore } from "@q9labsai/chalk-client";
import { useMemo } from "react";

import type { UseChatReturn } from "../../hooks/useChat";
import type { UseInteractionsReturn } from "../../hooks/useInteractions";
import type { ConferenceViewProps } from "../ConferenceView";
import type { ConferenceViewActionAvailability } from "./diagnostics";
import { resolveNativeScreenShareAvailability } from "./screen-share-availability";

export interface ConferenceViewCapabilities {
  readonly isHost: boolean;
  readonly canChat: boolean;
  readonly canParticipants: boolean;
  readonly canScreenShare: boolean;
  readonly canReactions: boolean;
  readonly canHandRaise: boolean;
  readonly canWhiteboard: boolean;
  readonly canManageAdmission: boolean;
  readonly canSetParticipantRole: boolean;
  readonly canTransferHost: boolean;
  readonly canRequestMedia: boolean;
  readonly canMuteParticipants: boolean;
  readonly canRemoveParticipants: boolean;
  readonly canStopParticipantCamera: boolean;
  readonly canStopParticipantScreenShare: boolean;
  readonly canModerate: boolean;
  readonly screenShareAvailability: ConferenceViewActionAvailability;
}

interface UseConferenceViewCapabilitiesOptions {
  readonly features: ConferenceViewProps["features"];
  readonly session: Pick<ChalkSessionStore, "whiteboard">;
  readonly snapshot: {
    readonly participants: readonly CapabilityParticipant[];
    readonly subject: CapabilitySubject | null;
  };
  readonly chat: Pick<UseChatReturn, "isEnabled">;
  readonly interactions: Pick<UseInteractionsReturn, "reactionEnabled">;
}

type CapabilityParticipant = Pick<ChalkSessionSnapshot["participants"][number], "participantSessionId" | "role" | "capabilities">;
type CapabilitySubject = Pick<NonNullable<ChalkSessionSnapshot["subject"]>, "participantSessionId">;

export function useConferenceViewCapabilities({ features, session, snapshot, chat, interactions }: UseConferenceViewCapabilitiesOptions): ConferenceViewCapabilities {
  const localParticipant = snapshot.participants.find((participant) => participant.participantSessionId === snapshot.subject?.participantSessionId);
  const capabilities = localParticipant?.capabilities ?? [];
  const isHost = localParticipant?.role === "host";
  const canChat = features?.chat !== false && chat.isEnabled;
  const canParticipants = features?.participants !== false;
  const canReactions = features?.reactions !== false && interactions.reactionEnabled;
  const canHandRaise = features?.handRaise !== false;
  const screenShareAvailability = useMemo(
    () =>
      resolveNativeScreenShareAvailability({
        featureEnabled: features?.screenShare !== false,
      }),
    [features?.screenShare],
  );
  const canScreenShare = screenShareAvailability.enabled;
  const canWhiteboard = features?.whiteboard !== false && session.whiteboard !== null;
  const canManageAdmission = capabilities.includes("manageAdmission");
  const canSetParticipantRole = capabilities.includes("assignRoles");
  const canTransferHost = capabilities.includes("assignRoles");
  const canRequestMedia = capabilities.includes("requestMediaOthers");
  const canMuteParticipants = capabilities.includes("muteOthers");
  const canRemoveParticipants = capabilities.includes("removeParticipant");
  const canStopParticipantCamera = capabilities.includes("stopVideoOthers");
  const canStopParticipantScreenShare = capabilities.includes("stopScreenOthers");
  const canModerate = canManageAdmission || canSetParticipantRole || canTransferHost || canRequestMedia || canMuteParticipants || canRemoveParticipants || canStopParticipantCamera || canStopParticipantScreenShare;

  return {
    isHost,
    canChat,
    canParticipants,
    canScreenShare,
    canReactions,
    canHandRaise,
    canWhiteboard,
    canManageAdmission,
    canSetParticipantRole,
    canTransferHost,
    canRequestMedia,
    canMuteParticipants,
    canRemoveParticipants,
    canStopParticipantCamera,
    canStopParticipantScreenShare,
    canModerate,
    screenShareAvailability,
  };
}
