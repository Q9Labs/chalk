import { useEffect, useMemo } from "react";

import type { MeetingRoomDiagnosticsSnapshot } from "./diagnostics";
import { buildMeetingRoomDiagnosticsSnapshot } from "./diagnostics";
import type { MeetingRoomCapabilities } from "./useMeetingRoomCapabilities";
import type { MeetingRoomInteractions } from "./useMeetingRoomInteractions";
import type { MeetingRoomParticipants } from "./useMeetingRoomParticipants";
import type { UseChatReturn } from "../../hooks/useChat";
import type { UseScreenShareReturn } from "../../hooks/useScreenShare";

export interface MeetingRoomDiagnostics {
  readonly roomDiagnostics: MeetingRoomDiagnosticsSnapshot;
}

interface UseMeetingRoomDiagnosticsOptions {
  readonly capabilities: Pick<MeetingRoomCapabilities, "canChat" | "canParticipants" | "canScreenShare" | "canReactions" | "canHandRaise" | "canWhiteboard" | "isHost" | "canModerate" | "screenShareAvailability">;
  readonly participants: Pick<MeetingRoomParticipants, "participantCount">;
  readonly chat: Pick<UseChatReturn, "unreadCount">;
  readonly interactions: Pick<MeetingRoomInteractions, "raisedHandCount">;
  readonly screenShare: Pick<UseScreenShareReturn, "isActive" | "isLocalSharing" | "sharerParticipantId">;
  readonly onDiagnosticsChange: ((snapshot: MeetingRoomDiagnosticsSnapshot) => void) | undefined;
}

export function useMeetingRoomDiagnostics({ capabilities, participants, chat, interactions, screenShare, onDiagnosticsChange }: UseMeetingRoomDiagnosticsOptions): MeetingRoomDiagnostics {
  const roomDiagnostics = useMemo(
    () =>
      buildMeetingRoomDiagnosticsSnapshot({
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
