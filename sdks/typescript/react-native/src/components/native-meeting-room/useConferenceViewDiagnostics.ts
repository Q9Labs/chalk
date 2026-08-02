import { useEffect, useMemo } from "react";

import type { ConferenceViewDiagnosticsSnapshot } from "./diagnostics";
import { buildConferenceViewDiagnosticsSnapshot } from "./diagnostics";
import type { ConferenceViewCapabilities } from "./useConferenceViewCapabilities";
import type { ConferenceViewInteractions } from "./useConferenceViewInteractions";
import type { ConferenceViewParticipants } from "./useConferenceViewParticipants";
import type { UseChatReturn } from "../../hooks/useChat";
import type { UseScreenShareReturn } from "../../hooks/useScreenShare";

export interface ConferenceViewDiagnostics {
  readonly roomDiagnostics: ConferenceViewDiagnosticsSnapshot;
}

interface UseConferenceViewDiagnosticsOptions {
  readonly capabilities: Pick<ConferenceViewCapabilities, "canChat" | "canParticipants" | "canScreenShare" | "canReactions" | "canHandRaise" | "canWhiteboard" | "isHost" | "canModerate" | "screenShareAvailability">;
  readonly participants: Pick<ConferenceViewParticipants, "participantCount">;
  readonly chat: Pick<UseChatReturn, "unreadCount">;
  readonly interactions: Pick<ConferenceViewInteractions, "raisedHandCount">;
  readonly screenShare: Pick<UseScreenShareReturn, "isActive" | "isLocalSharing" | "sharerParticipantId">;
  readonly onDiagnosticsChange: ((snapshot: ConferenceViewDiagnosticsSnapshot) => void) | undefined;
}

export function useConferenceViewDiagnostics({ capabilities, participants, chat, interactions, screenShare, onDiagnosticsChange }: UseConferenceViewDiagnosticsOptions): ConferenceViewDiagnostics {
  const roomDiagnostics = useMemo(
    () =>
      buildConferenceViewDiagnosticsSnapshot({
        featureFlags: {
          chat: capabilities.canChat,
          participants: capabilities.canParticipants,
          screenShare: capabilities.canScreenShare,
          reactions: capabilities.canReactions,
          handRaise: capabilities.canHandRaise,
          whiteboard: capabilities.canWhiteboard,
        },
        isHost: capabilities.isHost,
        participantCount: participants.participantCount,
        raisedHandCount: interactions.raisedHandCount,
        unreadChatCount: chat.unreadCount,
        isScreenShareActive: screenShare.isActive,
        isLocalScreenSharing: screenShare.isLocalSharing,
        screenShareSharerParticipantId: screenShare.sharerParticipantId,
        canModerate: capabilities.canModerate,
        screenShareAvailability: capabilities.screenShareAvailability,
      }),
    [
      capabilities.canChat,
      capabilities.canHandRaise,
      capabilities.canModerate,
      capabilities.canParticipants,
      capabilities.canReactions,
      capabilities.canScreenShare,
      capabilities.canWhiteboard,
      capabilities.isHost,
      capabilities.screenShareAvailability,
      chat.unreadCount,
      interactions.raisedHandCount,
      participants.participantCount,
      screenShare.isActive,
      screenShare.isLocalSharing,
      screenShare.sharerParticipantId,
    ],
  );
  useEffect(() => onDiagnosticsChange?.(roomDiagnostics), [onDiagnosticsChange, roomDiagnostics]);

  return { roomDiagnostics };
}
