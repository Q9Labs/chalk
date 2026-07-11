export interface NativeMeetingRoomFeatureFlags {
  chat: boolean;
  participants: boolean;
  transcripts: boolean;
  settings: boolean;
  screenShare: boolean;
  recording: boolean;
  reactions: boolean;
  handRaise: boolean;
  whiteboard: boolean;
}

export interface NativeMeetingRoomActionAvailability {
  enabled: boolean;
  reason: string | null;
  detail: string | null;
}

export interface NativeMeetingRoomDiagnosticsSnapshot {
  isHost: boolean;
  participantCount: number;
  raisedHandCount: number;
  unreadChatCount: number;
  featureFlags: NativeMeetingRoomFeatureFlags;
  actionAvailability: {
    screenShare: NativeMeetingRoomActionAvailability & {
      isActive: boolean;
      isLocalSharing: boolean;
      sharerParticipantId: string | null;
      visibleInBottomDock: boolean;
      enabledInActionsSheet: boolean;
    };
    reactions: NativeMeetingRoomActionAvailability;
    handRaise: NativeMeetingRoomActionAvailability;
    chat: NativeMeetingRoomActionAvailability;
    participants: NativeMeetingRoomActionAvailability;
    transcripts: NativeMeetingRoomActionAvailability;
    recording: NativeMeetingRoomActionAvailability;
    settings: NativeMeetingRoomActionAvailability;
    whiteboard: NativeMeetingRoomActionAvailability;
    moderation: NativeMeetingRoomActionAvailability & {
      canMuteOthers: boolean;
      canUnmuteOthers: boolean;
    };
  };
}

const enabledAction = (): NativeMeetingRoomActionAvailability => ({
  enabled: true,
  reason: null,
  detail: null,
});

const disabledByFeature = (featureName: string): NativeMeetingRoomActionAvailability => ({
  enabled: false,
  reason: "feature-disabled",
  detail: `features.${featureName}=false`,
});

export const buildNativeMeetingRoomDiagnosticsSnapshot = ({
  featureFlags,
  isHost,
  participantCount,
  raisedHandCount,
  unreadChatCount,
  isScreenShareActive,
  isLocalScreenSharing,
  screenShareSharerParticipantId,
  screenShareAvailability,
}: {
  featureFlags: NativeMeetingRoomFeatureFlags;
  isHost: boolean;
  participantCount: number;
  raisedHandCount: number;
  unreadChatCount: number;
  isScreenShareActive: boolean;
  isLocalScreenSharing: boolean;
  screenShareSharerParticipantId: string | null;
  screenShareAvailability?: NativeMeetingRoomActionAvailability;
}): NativeMeetingRoomDiagnosticsSnapshot => {
  const resolvedScreenShareAvailability =
    screenShareAvailability ??
    (featureFlags.screenShare
      ? enabledAction()
      : {
          ...disabledByFeature("screenShare"),
          detail: "features.screenShare=false in meeting room props",
        });

  return {
    isHost,
    participantCount,
    raisedHandCount,
    unreadChatCount,
    featureFlags,
    actionAvailability: {
      screenShare: {
        ...resolvedScreenShareAvailability,
        isActive: isScreenShareActive,
        isLocalSharing: isLocalScreenSharing,
        sharerParticipantId: screenShareSharerParticipantId,
        visibleInBottomDock: resolvedScreenShareAvailability.enabled,
        enabledInActionsSheet: resolvedScreenShareAvailability.enabled,
      },
      reactions: featureFlags.reactions ? enabledAction() : disabledByFeature("reactions"),
      handRaise: featureFlags.handRaise ? enabledAction() : disabledByFeature("handRaise"),
      chat: featureFlags.chat ? enabledAction() : disabledByFeature("chat"),
      participants: featureFlags.participants ? enabledAction() : disabledByFeature("participants"),
      transcripts: featureFlags.transcripts ? enabledAction() : disabledByFeature("transcripts"),
      recording: featureFlags.recording ? enabledAction() : disabledByFeature("recording"),
      settings: featureFlags.settings ? enabledAction() : disabledByFeature("settings"),
      whiteboard: featureFlags.whiteboard ? enabledAction() : disabledByFeature("whiteboard"),
      moderation: isHost
        ? {
            ...enabledAction(),
            canMuteOthers: true,
            canUnmuteOthers: true,
            detail: "local participant role=host",
          }
        : {
            enabled: false,
            reason: "not-host",
            detail: "local participant role is not host",
            canMuteOthers: false,
            canUnmuteOthers: false,
          },
    },
  };
};
