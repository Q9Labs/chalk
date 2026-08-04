export interface SpaceViewFeatureFlags {
  readonly chat: boolean;
  readonly participants: boolean;
  readonly screenShare: boolean;
  readonly reactions: boolean;
  readonly handRaise: boolean;
  readonly whiteboard: boolean;
}

export interface SpaceViewActionAvailability {
  readonly enabled: boolean;
  readonly reason: string | null;
  readonly detail: string | null;
}

export interface SpaceViewDiagnosticsSnapshot {
  readonly canEndEpisode: boolean;
  readonly participantCount: number;
  readonly raisedHandCount: number;
  readonly unreadChatCount: number;
  readonly featureFlags: SpaceViewFeatureFlags;
  readonly actionAvailability: {
    readonly screenShare: SpaceViewActionAvailability & {
      readonly isActive: boolean;
      readonly isLocalSharing: boolean;
      readonly sharerParticipantId: string | null;
      readonly visibleInBottomDock: boolean;
      readonly enabledInActionsSheet: boolean;
    };
    readonly reactions: SpaceViewActionAvailability;
    readonly handRaise: SpaceViewActionAvailability;
    readonly chat: SpaceViewActionAvailability;
    readonly participants: SpaceViewActionAvailability;
    readonly whiteboard: SpaceViewActionAvailability;
    readonly moderation: SpaceViewActionAvailability;
  };
}

export function buildSpaceViewDiagnosticsSnapshot(input: {
  readonly featureFlags: SpaceViewFeatureFlags;
  readonly canEndEpisode: boolean;
  readonly participantCount: number;
  readonly raisedHandCount: number;
  readonly unreadChatCount: number;
  readonly isScreenShareActive: boolean;
  readonly isLocalScreenSharing: boolean;
  readonly screenShareSharerParticipantId: string | null;
  readonly canModerate: boolean;
  readonly screenShareAvailability?: SpaceViewActionAvailability;
}): SpaceViewDiagnosticsSnapshot {
  const availability = (enabled: boolean, feature: keyof SpaceViewFeatureFlags) => (enabled ? enabledAction() : disabledAction(`features.${feature}=false`));
  const screenShare = input.screenShareAvailability ?? availability(input.featureFlags.screenShare, "screenShare");
  return {
    canEndEpisode: input.canEndEpisode,
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
      moderation: input.canModerate ? enabledAction() : { enabled: false, reason: "capability-unavailable", detail: "The local participant cannot moderate participants" },
    },
  };
}

function enabledAction(): SpaceViewActionAvailability {
  return { enabled: true, reason: null, detail: null };
}

function disabledAction(detail: string): SpaceViewActionAvailability {
  return { enabled: false, reason: "feature-disabled", detail };
}
