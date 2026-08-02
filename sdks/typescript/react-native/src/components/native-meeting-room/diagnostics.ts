export interface ConferenceViewFeatureFlags {
  readonly chat: boolean;
  readonly participants: boolean;
  readonly screenShare: boolean;
  readonly reactions: boolean;
  readonly handRaise: boolean;
  readonly whiteboard: boolean;
}

export interface ConferenceViewActionAvailability {
  readonly enabled: boolean;
  readonly reason: string | null;
  readonly detail: string | null;
}

export interface ConferenceViewDiagnosticsSnapshot {
  readonly isHost: boolean;
  readonly participantCount: number;
  readonly raisedHandCount: number;
  readonly unreadChatCount: number;
  readonly featureFlags: ConferenceViewFeatureFlags;
  readonly actionAvailability: {
    readonly screenShare: ConferenceViewActionAvailability & {
      readonly isActive: boolean;
      readonly isLocalSharing: boolean;
      readonly sharerParticipantId: string | null;
      readonly visibleInBottomDock: boolean;
      readonly enabledInActionsSheet: boolean;
    };
    readonly reactions: ConferenceViewActionAvailability;
    readonly handRaise: ConferenceViewActionAvailability;
    readonly chat: ConferenceViewActionAvailability;
    readonly participants: ConferenceViewActionAvailability;
    readonly whiteboard: ConferenceViewActionAvailability;
    readonly moderation: ConferenceViewActionAvailability;
  };
}

export function buildConferenceViewDiagnosticsSnapshot(input: {
  readonly featureFlags: ConferenceViewFeatureFlags;
  readonly isHost: boolean;
  readonly participantCount: number;
  readonly raisedHandCount: number;
  readonly unreadChatCount: number;
  readonly isScreenShareActive: boolean;
  readonly isLocalScreenSharing: boolean;
  readonly screenShareSharerParticipantId: string | null;
  readonly canModerate: boolean;
  readonly screenShareAvailability?: ConferenceViewActionAvailability;
}): ConferenceViewDiagnosticsSnapshot {
  const availability = (enabled: boolean, feature: keyof ConferenceViewFeatureFlags) => (enabled ? enabledAction() : disabledAction(`features.${feature}=false`));
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

function enabledAction(): ConferenceViewActionAvailability {
  return { enabled: true, reason: null, detail: null };
}

function disabledAction(detail: string): ConferenceViewActionAvailability {
  return { enabled: false, reason: "feature-disabled", detail };
}
