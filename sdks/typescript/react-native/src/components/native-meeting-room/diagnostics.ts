export interface MeetingRoomFeatureFlags {
  readonly chat: boolean;
  readonly participants: boolean;
  readonly screenShare: boolean;
  readonly reactions: boolean;
  readonly handRaise: boolean;
  readonly whiteboard: boolean;
}

export interface MeetingRoomActionAvailability {
  readonly enabled: boolean;
  readonly reason: string | null;
  readonly detail: string | null;
}

export interface MeetingRoomDiagnosticsSnapshot {
  readonly isHost: boolean;
  readonly participantCount: number;
  readonly raisedHandCount: number;
  readonly unreadChatCount: number;
  readonly featureFlags: MeetingRoomFeatureFlags;
  readonly actionAvailability: {
    readonly screenShare: MeetingRoomActionAvailability & {
      readonly isActive: boolean;
      readonly isLocalSharing: boolean;
      readonly sharerParticipantId: string | null;
      readonly visibleInBottomDock: boolean;
      readonly enabledInActionsSheet: boolean;
    };
    readonly reactions: MeetingRoomActionAvailability;
    readonly handRaise: MeetingRoomActionAvailability;
    readonly chat: MeetingRoomActionAvailability;
    readonly participants: MeetingRoomActionAvailability;
    readonly whiteboard: MeetingRoomActionAvailability;
    readonly moderation: MeetingRoomActionAvailability;
  };
}

export function buildMeetingRoomDiagnosticsSnapshot(input: {
  readonly featureFlags: MeetingRoomFeatureFlags;
  readonly isHost: boolean;
  readonly participantCount: number;
  readonly raisedHandCount: number;
  readonly unreadChatCount: number;
  readonly isScreenShareActive: boolean;
  readonly isLocalScreenSharing: boolean;
  readonly screenShareSharerParticipantId: string | null;
  readonly canModerate: boolean;
  readonly screenShareAvailability?: MeetingRoomActionAvailability;
}): MeetingRoomDiagnosticsSnapshot {
  const availability = (enabled: boolean, feature: keyof MeetingRoomFeatureFlags) => (enabled ? enabledAction() : disabledAction(`features.${feature}=false`));
  const screenShare = input.screenShareAvailability ?? availability(input.featureFlags.screenShare, "screenShare");
  return {
    isHost: input.isHost,
    participantCount: input.participantCount,
    raisedHandCount: input.raisedHandCount,
    unreadChatCount: input.unreadChatCount,
    featureFlags: input.featureFlags,
    actionAvailability: {
      screenShare: {
        ...screenShare,
        isActive: input.isScreenShareActive,
        isLocalSharing: input.isLocalScreenSharing,
        sharerParticipantId: input.screenShareSharerParticipantId,
        visibleInBottomDock: false,
        enabledInActionsSheet: screenShare.enabled,
      },
      reactions: availability(input.featureFlags.reactions, "reactions"),
      handRaise: availability(input.featureFlags.handRaise, "handRaise"),
      chat: availability(input.featureFlags.chat, "chat"),
      participants: availability(input.featureFlags.participants, "participants"),
      whiteboard: availability(input.featureFlags.whiteboard, "whiteboard"),
      moderation: input.canModerate ? enabledAction() : { enabled: false, reason: "not-host", detail: "The local role cannot moderate participants" },
    },
  };
}

function enabledAction(): MeetingRoomActionAvailability {
  return { enabled: true, reason: null, detail: null };
}

function disabledAction(detail: string): MeetingRoomActionAvailability {
  return { enabled: false, reason: "feature-disabled", detail };
}
