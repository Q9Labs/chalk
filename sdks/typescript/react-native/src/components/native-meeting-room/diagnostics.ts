export interface NativeMeetingRoomFeatureFlags {
  readonly chat: boolean;
  readonly participants: boolean;
  readonly screenShare: boolean;
  readonly reactions: boolean;
  readonly handRaise: boolean;
  readonly whiteboard: boolean;
}

export interface NativeMeetingRoomActionAvailability {
  readonly enabled: boolean;
  readonly reason: string | null;
  readonly detail: string | null;
}

export interface NativeMeetingRoomDiagnosticsSnapshot {
  readonly isHost: boolean;
  readonly participantCount: number;
  readonly raisedHandCount: number;
  readonly unreadChatCount: number;
  readonly featureFlags: NativeMeetingRoomFeatureFlags;
  readonly actionAvailability: {
    readonly screenShare: NativeMeetingRoomActionAvailability & {
      readonly isActive: boolean;
      readonly isLocalSharing: boolean;
      readonly sharerParticipantId: string | null;
      readonly visibleInBottomDock: boolean;
      readonly enabledInActionsSheet: boolean;
    };
    readonly reactions: NativeMeetingRoomActionAvailability;
    readonly handRaise: NativeMeetingRoomActionAvailability;
    readonly chat: NativeMeetingRoomActionAvailability;
    readonly participants: NativeMeetingRoomActionAvailability;
    readonly whiteboard: NativeMeetingRoomActionAvailability;
    readonly moderation: NativeMeetingRoomActionAvailability;
  };
}

export function buildNativeMeetingRoomDiagnosticsSnapshot(input: {
  readonly featureFlags: NativeMeetingRoomFeatureFlags;
  readonly isHost: boolean;
  readonly participantCount: number;
  readonly raisedHandCount: number;
  readonly unreadChatCount: number;
  readonly isScreenShareActive: boolean;
  readonly isLocalScreenSharing: boolean;
  readonly screenShareSharerParticipantId: string | null;
  readonly canModerate: boolean;
  readonly screenShareAvailability?: NativeMeetingRoomActionAvailability;
}): NativeMeetingRoomDiagnosticsSnapshot {
  const availability = (enabled: boolean, feature: keyof NativeMeetingRoomFeatureFlags) => (enabled ? enabledAction() : disabledAction(`features.${feature}=false`));
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

function enabledAction(): NativeMeetingRoomActionAvailability {
  return { enabled: true, reason: null, detail: null };
}

function disabledAction(detail: string): NativeMeetingRoomActionAvailability {
  return { enabled: false, reason: "feature-disabled", detail };
}
