export const RECORDING_PRESENTATION_SCHEMA_VERSION = "recording_presentation.v1";

export const RECORDING_PRESENTATION_LIMITS = {
  assets: 256,
  chatMessages: 100,
  eventBytes: 32_768,
  events: 100_000,
  participants: 500,
  reactions: 500,
  timelineBytes: 67_108_864,
} as const;

export type RecordingPresentationSchemaVersion = typeof RECORDING_PRESENTATION_SCHEMA_VERSION;

export interface RecordingPresentationViewportV1 {
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor: number;
}

export interface RecordingPresentationThemeV1 {
  readonly colorScheme: "light" | "dark";
  readonly skin: "classic" | "chalk";
  readonly palette:
    | "light"
    | "warm-porcelain"
    | "cool-mist"
    | "paper-and-ink"
    | "cream-and-clay"
    | "studio-canvas"
    | "prism-daylight"
    | "signal-white"
    | "warm-charcoal"
    | "cool-graphite"
    | "high-contrast-ink"
    | "espresso-night"
    | "chalkboard-atelier"
    | "prism-nocturne"
    | "cosmic-chalk"
    | "oled-signal";
  readonly texture: "none" | "paper" | "slate";
  readonly stageBackground: boolean;
  readonly generatedAvatars: boolean;
}

export interface RecordingPresentationProfileV1 {
  readonly name: string;
  readonly version: string;
  readonly uiBuildSha256: string;
  readonly viewport: RecordingPresentationViewportV1;
  readonly locale: string;
  readonly timeZone: string;
  readonly fontAssetIds: readonly string[];
  readonly theme: RecordingPresentationThemeV1;
}

export interface RecordingPresentationClockV1 {
  readonly origin: "capture_ready";
  readonly timebase: "recording_relative_ms";
  readonly captureEpoch: number;
  readonly originAuthorityId: string;
  readonly durationMs: number;
}

export interface RecordingPresentationSpaceV1 {
  readonly id: string;
  readonly name: string;
  readonly logoAssetId?: string;
}

export interface RecordingPresentationViewV1 {
  readonly layout: "grid" | "presentation";
  readonly sidebar: "chat";
}

export interface RecordingPresentationParticipantV1 {
  readonly id: string;
  readonly displayName: string;
  readonly joinOrdinal: number;
  readonly joined: boolean;
  readonly microphoneMuted: boolean;
  readonly cameraEnabled: boolean;
  readonly screenShareEnabled: boolean;
  readonly speaking: boolean;
  readonly activeSpeaker: boolean;
  readonly handRaised: boolean;
  readonly avatarAssetId?: string;
}

export interface RecordingPresentationAttachmentV1 {
  readonly id: string;
  readonly assetId: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly byteSize: number;
}

export interface RecordingPresentationChatMessageV1 {
  readonly id: string;
  readonly sequence: number;
  readonly participantId: string;
  readonly displayName: string;
  readonly text: string;
  readonly createdAtMs: number;
  readonly displayTime: string;
  readonly attachments: readonly RecordingPresentationAttachmentV1[];
}

export interface RecordingPresentationChatV1 {
  readonly retainedFloorSequence: number | null;
  readonly headSequence: number;
  readonly messages: readonly RecordingPresentationChatMessageV1[];
}

export interface RecordingPresentationReactionV1 {
  readonly id: string;
  readonly participantId: string;
  readonly displayName: string;
  readonly value: "👍" | "❤️" | "😂" | "😮" | "😢" | "🎉";
  readonly occurredAtMs: number;
  readonly expiresAtMs: number;
}

export interface RecordingMediaSourceV1 {
  readonly sourceId: string;
  readonly participantId: string;
  readonly participantGeneration: number;
  readonly kind: "microphone" | "camera" | "screen_share";
  readonly trackId: string;
  readonly epoch: number;
  readonly visible: boolean;
}

export type RecordingSharedContentV1 =
  | { readonly kind: "none" }
  | {
      readonly kind: "screen_share";
      readonly participantId: string;
      readonly sourceId: string;
    }
  | {
      readonly kind: "whiteboard";
      readonly sceneId: string;
      readonly revision: number;
      readonly stateAssetId: string;
    };

export interface RecordingPresentationSnapshotV1 {
  readonly elapsedMs: number;
  readonly profile: RecordingPresentationProfileV1;
  readonly space: RecordingPresentationSpaceV1;
  readonly view: RecordingPresentationViewV1;
  readonly participants: readonly RecordingPresentationParticipantV1[];
  readonly media: readonly RecordingMediaSourceV1[];
  readonly chat: RecordingPresentationChatV1;
  readonly sharedContent: RecordingSharedContentV1;
  readonly reactions: readonly RecordingPresentationReactionV1[];
}

export interface RecordingPresentationAssetV1 {
  readonly id: string;
  readonly kind: "logo" | "avatar" | "chat_attachment" | "whiteboard_state" | "whiteboard_file" | "font";
  readonly objectKey: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly sha256: string;
}

export interface RecordingPresentationSourceCursorsV1 {
  readonly episodeControlStartRevision: number;
  readonly episodeControlEndRevision: number;
  readonly chatStartSequence: number;
  readonly chatEndSequence: number;
  readonly whiteboardStartRevision: number;
  readonly whiteboardEndRevision: number;
  readonly capturePlanStartRevision: number;
  readonly capturePlanEndRevision: number;
}

interface RecordingPresentationEventBaseV1 {
  readonly atMs: number;
  readonly sequence: number;
}

export type RecordingPresentationEventV1 =
  | (RecordingPresentationEventBaseV1 & {
      readonly kind: "participant_joined";
      readonly participant: RecordingPresentationParticipantV1;
    })
  | (RecordingPresentationEventBaseV1 & {
      readonly kind: "participant_left";
      readonly participantId: string;
    })
  | (RecordingPresentationEventBaseV1 & {
      readonly kind: "participant_display_name_changed";
      readonly participantId: string;
      readonly displayName: string;
    })
  | (RecordingPresentationEventBaseV1 & {
      readonly kind: "participant_hand_raised_changed";
      readonly participantId: string;
      readonly raised: boolean;
    })
  | (RecordingPresentationEventBaseV1 & {
      readonly kind: "participant_microphone_changed";
      readonly participantId: string;
      readonly muted: boolean;
    })
  | (RecordingPresentationEventBaseV1 & {
      readonly kind: "participant_camera_changed";
      readonly participantId: string;
      readonly enabled: boolean;
    })
  | (RecordingPresentationEventBaseV1 & {
      readonly kind: "participant_screen_share_changed";
      readonly participantId: string;
      readonly enabled: boolean;
    })
  | (RecordingPresentationEventBaseV1 & {
      readonly kind: "participant_speaking_changed";
      readonly participantId: string;
      readonly speaking: boolean;
    })
  | (RecordingPresentationEventBaseV1 & {
      readonly kind: "active_speaker_changed";
      readonly participantId: string | null;
    })
  | (RecordingPresentationEventBaseV1 & {
      readonly kind: "media_source_changed";
      readonly source: RecordingMediaSourceV1;
    })
  | (RecordingPresentationEventBaseV1 & {
      readonly kind: "chat_message_added";
      readonly message: RecordingPresentationChatMessageV1;
    })
  | (RecordingPresentationEventBaseV1 & {
      readonly kind: "reaction_added";
      readonly reaction: RecordingPresentationReactionV1;
    })
  | (RecordingPresentationEventBaseV1 & {
      readonly kind: "shared_content_changed";
      readonly sharedContent: RecordingSharedContentV1;
    });

export interface RecordingPresentationTimelineV1 {
  readonly schemaVersion: RecordingPresentationSchemaVersion;
  readonly recordingId: string;
  readonly episodeId: string;
  readonly clock: RecordingPresentationClockV1;
  readonly sourceCursors: RecordingPresentationSourceCursorsV1;
  readonly initial: RecordingPresentationSnapshotV1;
  readonly events: readonly RecordingPresentationEventV1[];
  readonly assets: readonly RecordingPresentationAssetV1[];
}
