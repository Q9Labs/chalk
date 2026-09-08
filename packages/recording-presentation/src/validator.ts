import {
  RECORDING_PRESENTATION_LIMITS,
  RECORDING_PRESENTATION_SCHEMA_VERSION,
  type RecordingMediaSourceV1,
  type RecordingPresentationAssetV1,
  type RecordingPresentationAttachmentV1,
  type RecordingPresentationChatMessageV1,
  type RecordingPresentationEventV1,
  type RecordingPresentationParticipantV1,
  type RecordingPresentationProfileV1,
  type RecordingPresentationReactionV1,
  type RecordingPresentationSnapshotV1,
  type RecordingPresentationSourceCursorsV1,
  type RecordingPresentationTimelineV1,
  type RecordingSharedContentV1,
} from "./types.js";

const REACTIONS = new Set(["👍", "❤️", "😂", "😮", "😢", "🎉"]);
const ASSET_KINDS = new Set(["logo", "avatar", "chat_attachment", "whiteboard_state", "whiteboard_file", "font"]);
const MEDIA_SOURCE_KINDS = new Set(["microphone", "camera", "screen_share"]);
const THEME_SKINS = new Set(["classic", "chalk"]);
const THEME_TEXTURES = new Set(["none", "paper", "slate"]);
const THEME_PALETTES = new Set([
  "light",
  "warm-porcelain",
  "cool-mist",
  "paper-and-ink",
  "cream-and-clay",
  "studio-canvas",
  "prism-daylight",
  "signal-white",
  "warm-charcoal",
  "cool-graphite",
  "high-contrast-ink",
  "espresso-night",
  "chalkboard-atelier",
  "prism-nocturne",
  "cosmic-chalk",
  "oled-signal",
]);

const isObject = (value: unknown): value is object => typeof value === "object" && value !== null && !Array.isArray(value);
const property = (value: object, key: string): unknown => Reflect.get(value, key);
const isInteger = (value: unknown, minimum = 0): value is number => Number.isSafeInteger(value) && typeof value === "number" && value >= minimum;
const isBoundedString = (value: unknown, maximum = 512): value is string => typeof value === "string" && value.length > 0 && value.length <= maximum;
const isOptionalBoundedString = (value: unknown, maximum = 512): value is string | undefined => value === undefined || isBoundedString(value, maximum);
const isSHA256 = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const isNullablePositiveInteger = (value: unknown): value is number | null => value === null || isInteger(value, 1);

const hasExactKeys = (value: object, required: readonly string[], optional: readonly string[] = []): boolean => {
  const keys = Object.keys(value);
  if (keys.length < required.length || keys.length > required.length + optional.length) return false;
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => required.includes(key) || optional.includes(key));
};

const isStringArray = (value: unknown, maximum: number): value is readonly string[] => Array.isArray(value) && value.length <= maximum && value.every((item) => isBoundedString(item));

const uniqueBy = <T>(items: readonly T[], key: (item: T) => string): boolean => {
  const keys = new Set<string>();
  for (const item of items) {
    const value = key(item);
    if (keys.has(value)) return false;
    keys.add(value);
  }
  return true;
};

const isBoundedArray = <T>(value: unknown, maximum: number, itemGuard: (item: unknown) => item is T): value is readonly T[] => Array.isArray(value) && value.length <= maximum && value.every(itemGuard);

const isBoundedUniqueArray = <T>(value: unknown, maximum: number, itemGuard: (item: unknown) => item is T, key: (item: T) => string): value is readonly T[] => isBoundedArray(value, maximum, itemGuard) && uniqueBy(value, key);

const visibleSourcesAreUnambiguous = (sources: readonly RecordingMediaSourceV1[]): boolean =>
  uniqueBy(
    sources.filter((source) => source.visible),
    (source) => `${source.participantId}\u0000${source.kind}`,
  );

const screenShareResolves = (sharedContent: RecordingSharedContentV1, sources: readonly RecordingMediaSourceV1[]): boolean =>
  sharedContent.kind !== "screen_share" || sources.some((source) => source.sourceId === sharedContent.sourceId && source.participantId === sharedContent.participantId && source.kind === "screen_share" && source.visible);

type ValueCheck = (value: unknown) => boolean;
type ObjectCheck = (value: object) => boolean;

interface ObjectSchema {
  readonly keys: readonly string[];
  readonly checks: readonly ObjectCheck[];
  readonly optionalKeys?: readonly string[];
}

const checkField =
  (key: string, check: ValueCheck): ObjectCheck =>
  (value) =>
    check(property(value, key));
const boundedString =
  (maximum = 512): ValueCheck =>
  (value) =>
    isBoundedString(value, maximum);
const optionalBoundedString =
  (maximum = 512): ValueCheck =>
  (value) =>
    isOptionalBoundedString(value, maximum);
const integer =
  (minimum = 0): ValueCheck =>
  (value) =>
    isInteger(value, minimum);
const literal =
  (expected: unknown): ValueCheck =>
  (value) =>
    value === expected;
const knownString =
  (values: ReadonlySet<string>): ValueCheck =>
  (value) =>
    typeof value === "string" && values.has(value);
const patternedString =
  (pattern: RegExp): ValueCheck =>
  (value) =>
    typeof value === "string" && pattern.test(value);
const finiteNumberBetween =
  (minimum: number, maximum: number): ValueCheck =>
  (value) =>
    typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;

const matchesSchema = (value: object, schema: ObjectSchema): boolean => hasExactKeys(value, schema.keys, schema.optionalKeys) && schema.checks.every((check) => check(value));

const isExactObject = (value: unknown, schema: ObjectSchema): boolean => {
  if (!isObject(value)) return false;
  return matchesSchema(value, schema);
};

const VIEWPORT_SCHEMA: ObjectSchema = {
  keys: ["width", "height", "deviceScaleFactor"],
  checks: [checkField("width", integer(320)), checkField("height", integer(240)), checkField("deviceScaleFactor", finiteNumberBetween(1, 4))],
};

const THEME_SCHEMA: ObjectSchema = {
  keys: ["colorScheme", "skin", "palette", "texture", "stageBackground", "generatedAvatars"],
  checks: [
    checkField("colorScheme", knownString(new Set(["light", "dark"]))),
    checkField("skin", knownString(THEME_SKINS)),
    checkField("palette", knownString(THEME_PALETTES)),
    checkField("texture", knownString(THEME_TEXTURES)),
    checkField("stageBackground", isBoolean),
    checkField("generatedAvatars", isBoolean),
  ],
};

const isViewport = (value: unknown): boolean => isExactObject(value, VIEWPORT_SCHEMA);
const isTheme = (value: unknown): boolean => isExactObject(value, THEME_SCHEMA);

const PROFILE_SCHEMA: ObjectSchema = {
  keys: ["name", "version", "uiBuildSha256", "viewport", "locale", "timeZone", "fontAssetIds", "theme"],
  checks: [
    checkField("name", boundedString(128)),
    checkField("version", boundedString(128)),
    checkField("uiBuildSha256", isSHA256),
    checkField("viewport", isViewport),
    checkField("locale", boundedString(64)),
    checkField("timeZone", boundedString(128)),
    checkField("fontAssetIds", (value) => isStringArray(value, 32)),
    checkField("theme", isTheme),
  ],
};

const isProfile = (value: unknown): value is RecordingPresentationProfileV1 => isExactObject(value, PROFILE_SCHEMA);

const PARTICIPANT_SCHEMA: ObjectSchema = {
  keys: ["id", "displayName", "joinOrdinal", "joined", "microphoneMuted", "cameraEnabled", "screenShareEnabled", "speaking", "activeSpeaker", "handRaised"],
  optionalKeys: ["avatarAssetId"],
  checks: [
    checkField("id", boundedString()),
    checkField("displayName", boundedString(256)),
    checkField("joinOrdinal", integer(1)),
    checkField("joined", isBoolean),
    checkField("microphoneMuted", isBoolean),
    checkField("cameraEnabled", isBoolean),
    checkField("screenShareEnabled", isBoolean),
    checkField("speaking", isBoolean),
    checkField("activeSpeaker", isBoolean),
    checkField("handRaised", isBoolean),
    checkField("avatarAssetId", optionalBoundedString()),
  ],
};

const isParticipant = (value: unknown): value is RecordingPresentationParticipantV1 => isExactObject(value, PARTICIPANT_SCHEMA);

const ATTACHMENT_SCHEMA: ObjectSchema = {
  keys: ["id", "assetId", "fileName", "contentType", "byteSize"],
  checks: [checkField("id", boundedString()), checkField("assetId", boundedString()), checkField("fileName", boundedString(255)), checkField("contentType", boundedString(255)), checkField("byteSize", integer(1))],
};

const isAttachment = (value: unknown): value is RecordingPresentationAttachmentV1 => isExactObject(value, ATTACHMENT_SCHEMA);
const isAttachmentList = (value: unknown): value is readonly RecordingPresentationAttachmentV1[] => isBoundedUniqueArray(value, 5, isAttachment, (attachment) => attachment.id);
const isChatText = (value: unknown): value is string => typeof value === "string" && value.length <= 4_000;

const CHAT_MESSAGE_SCHEMA: ObjectSchema = {
  keys: ["id", "sequence", "participantId", "displayName", "text", "createdAtMs", "displayTime", "attachments"],
  checks: [
    checkField("id", boundedString()),
    checkField("sequence", integer(1)),
    checkField("participantId", boundedString()),
    checkField("displayName", boundedString(256)),
    checkField("text", isChatText),
    checkField("createdAtMs", integer()),
    checkField("displayTime", boundedString(64)),
    checkField("attachments", isAttachmentList),
  ],
};

const isChatMessage = (value: unknown): value is RecordingPresentationChatMessageV1 => isExactObject(value, CHAT_MESSAGE_SCHEMA);

const reactionWindowIsValid: ObjectCheck = (value) => Number(property(value, "expiresAtMs")) > Number(property(value, "occurredAtMs"));
const REACTION_SCHEMA: ObjectSchema = {
  keys: ["id", "participantId", "displayName", "value", "occurredAtMs", "expiresAtMs"],
  checks: [checkField("id", boundedString()), checkField("participantId", boundedString()), checkField("displayName", boundedString(256)), checkField("value", knownString(REACTIONS)), checkField("occurredAtMs", integer()), checkField("expiresAtMs", integer(1)), reactionWindowIsValid],
};

const isReaction = (value: unknown): value is RecordingPresentationReactionV1 => isExactObject(value, REACTION_SCHEMA);

const mediaSourceVisibilityIsValid: ObjectCheck = (value) => property(value, "kind") !== "microphone" || property(value, "visible") === false;
const MEDIA_SOURCE_SCHEMA: ObjectSchema = {
  keys: ["sourceId", "participantId", "participantGeneration", "kind", "trackId", "epoch", "visible"],
  checks: [
    checkField("sourceId", patternedString(/^rps_[0-9a-f]{64}$/)),
    checkField("participantId", boundedString()),
    checkField("participantGeneration", integer(1)),
    checkField("kind", knownString(MEDIA_SOURCE_KINDS)),
    checkField("trackId", boundedString()),
    checkField("epoch", integer(1)),
    checkField("visible", isBoolean),
    mediaSourceVisibilityIsValid,
  ],
};

const isMediaSource = (value: unknown): value is RecordingMediaSourceV1 => isExactObject(value, MEDIA_SOURCE_SCHEMA);

const SHARED_CONTENT_SCHEMAS = new Map<string, ObjectSchema>([
  ["none", { keys: ["kind"], checks: [] }],
  ["screen_share", { keys: ["kind", "participantId", "sourceId"], checks: [checkField("participantId", boundedString()), checkField("sourceId", boundedString())] }],
  ["whiteboard", { keys: ["kind", "sceneId", "revision", "stateAssetId"], checks: [checkField("sceneId", boundedString()), checkField("revision", integer()), checkField("stateAssetId", boundedString())] }],
]);

const schemaFor = (schemas: ReadonlyMap<string, ObjectSchema>, key: unknown): ObjectSchema | undefined => (typeof key === "string" ? schemas.get(key) : undefined);

const isSharedContent = (value: unknown): value is RecordingSharedContentV1 => {
  if (!isObject(value)) return false;
  const schema = schemaFor(SHARED_CONTENT_SCHEMAS, property(value, "kind"));
  return schema !== undefined && matchesSchema(value, schema);
};

const SPACE_SCHEMA: ObjectSchema = {
  keys: ["id", "name"],
  optionalKeys: ["logoAssetId"],
  checks: [checkField("id", boundedString()), checkField("name", boundedString(256)), checkField("logoAssetId", optionalBoundedString())],
};

const VIEW_SCHEMA: ObjectSchema = {
  keys: ["layout", "sidebar"],
  checks: [checkField("layout", knownString(new Set(["grid", "presentation"]))), checkField("sidebar", literal("chat"))],
};

const isParticipants = (value: unknown): value is readonly RecordingPresentationParticipantV1[] => isBoundedUniqueArray(value, RECORDING_PRESENTATION_LIMITS.participants, isParticipant, (participant) => participant.id) && value.filter((participant) => participant.activeSpeaker).length <= 1;

const isMedia = (value: unknown): value is readonly RecordingMediaSourceV1[] => isBoundedUniqueArray(value, RECORDING_PRESENTATION_LIMITS.participants * 2, isMediaSource, (source) => source.sourceId) && visibleSourcesAreUnambiguous(value);

const isChat = (value: unknown): boolean =>
  isExactObject(value, {
    keys: ["retainedFloorSequence", "headSequence", "messages"],
    checks: [checkField("retainedFloorSequence", isNullablePositiveInteger), checkField("headSequence", integer()), checkField("messages", (messages) => isBoundedArray(messages, RECORDING_PRESENTATION_LIMITS.chatMessages, isChatMessage))],
  });

const isReactions = (value: unknown): value is readonly RecordingPresentationReactionV1[] => isBoundedUniqueArray(value, RECORDING_PRESENTATION_LIMITS.reactions, isReaction, (reaction) => reaction.id);

const SNAPSHOT_SCHEMA: ObjectSchema = {
  keys: ["elapsedMs", "profile", "space", "view", "participants", "media", "chat", "sharedContent", "reactions"],
  checks: [
    checkField("elapsedMs", integer()),
    checkField("profile", isProfile),
    checkField("space", (space) => isExactObject(space, SPACE_SCHEMA)),
    checkField("view", (view) => isExactObject(view, VIEW_SCHEMA)),
    checkField("participants", isParticipants),
    checkField("media", isMedia),
    checkField("chat", isChat),
    checkField("sharedContent", isSharedContent),
    checkField("reactions", isReactions),
  ],
};

const isSnapshotStructure = (value: unknown): value is RecordingPresentationSnapshotV1 => isExactObject(value, SNAPSHOT_SCHEMA);

const snapshotRelationsAreValid = (snapshot: RecordingPresentationSnapshotV1): boolean => {
  const expectedLayout = snapshot.sharedContent.kind === "none" ? "grid" : "presentation";
  if (snapshot.view.layout !== expectedLayout) return false;
  return screenShareResolves(snapshot.sharedContent, snapshot.media);
};

const isSnapshot = (value: unknown): value is RecordingPresentationSnapshotV1 => isSnapshotStructure(value) && snapshotRelationsAreValid(value);

const ASSET_SCHEMA: ObjectSchema = {
  keys: ["id", "kind", "objectKey", "contentType", "byteSize", "sha256"],
  checks: [checkField("id", boundedString()), checkField("kind", knownString(ASSET_KINDS)), checkField("objectKey", boundedString(1_024)), checkField("contentType", boundedString(255)), checkField("byteSize", integer(1)), checkField("sha256", isSHA256)],
};

const isAsset = (value: unknown): value is RecordingPresentationAssetV1 => isExactObject(value, ASSET_SCHEMA);

const cursorRange =
  (start: string, end: string): ObjectCheck =>
  (value) =>
    isInteger(property(value, start)) && isInteger(property(value, end)) && Number(property(value, end)) >= Number(property(value, start));
const SOURCE_CURSOR_SCHEMA: ObjectSchema = {
  keys: ["episodeControlStartRevision", "episodeControlEndRevision", "chatStartSequence", "chatEndSequence", "whiteboardStartRevision", "whiteboardEndRevision", "capturePlanStartRevision", "capturePlanEndRevision"],
  checks: [cursorRange("episodeControlStartRevision", "episodeControlEndRevision"), cursorRange("chatStartSequence", "chatEndSequence"), cursorRange("whiteboardStartRevision", "whiteboardEndRevision"), cursorRange("capturePlanStartRevision", "capturePlanEndRevision")],
};

const isSourceCursors = (value: unknown): value is RecordingPresentationSourceCursorsV1 => isExactObject(value, SOURCE_CURSOR_SCHEMA);

const EVENT_BASE_KEYS = ["atMs", "sequence", "kind"];
const EVENT_SCHEMAS = new Map<string, ObjectSchema>([
  ["participant_joined", { keys: ["participant"], checks: [checkField("participant", isParticipant)] }],
  ["participant_left", { keys: ["participantId"], checks: [checkField("participantId", boundedString())] }],
  ["participant_display_name_changed", { keys: ["participantId", "displayName"], checks: [checkField("participantId", boundedString()), checkField("displayName", boundedString(256))] }],
  ["participant_hand_raised_changed", { keys: ["participantId", "raised"], checks: [checkField("participantId", boundedString()), checkField("raised", isBoolean)] }],
  ["participant_microphone_changed", { keys: ["participantId", "muted"], checks: [checkField("participantId", boundedString()), checkField("muted", isBoolean)] }],
  ["participant_camera_changed", { keys: ["participantId", "enabled"], checks: [checkField("participantId", boundedString()), checkField("enabled", isBoolean)] }],
  ["participant_screen_share_changed", { keys: ["participantId", "enabled"], checks: [checkField("participantId", boundedString()), checkField("enabled", isBoolean)] }],
  ["participant_speaking_changed", { keys: ["participantId", "speaking"], checks: [checkField("participantId", boundedString()), checkField("speaking", isBoolean)] }],
  ["active_speaker_changed", { keys: ["participantId"], checks: [checkField("participantId", (participantId) => participantId === null || isBoundedString(participantId))] }],
  ["media_source_changed", { keys: ["source"], checks: [checkField("source", isMediaSource)] }],
  ["chat_message_added", { keys: ["message"], checks: [checkField("message", isChatMessage)] }],
  ["reaction_added", { keys: ["reaction"], checks: [checkField("reaction", isReaction)] }],
  ["shared_content_changed", { keys: ["sharedContent"], checks: [checkField("sharedContent", isSharedContent)] }],
]);

const eventEnvelopeIsValid = (value: object, durationMs: number): boolean => isInteger(property(value, "atMs")) && Number(property(value, "atMs")) <= durationMs && isInteger(property(value, "sequence"), 1);
const eventFieldsAreValid = (value: object, schema: ObjectSchema): boolean => hasExactKeys(value, [...EVENT_BASE_KEYS, ...schema.keys]) && schema.checks.every((check) => check(value));

const isEvent = (value: unknown, durationMs: number): value is RecordingPresentationEventV1 => {
  if (!isObject(value)) return false;
  const schema = schemaFor(EVENT_SCHEMAS, property(value, "kind"));
  return schema !== undefined && eventEnvelopeIsValid(value, durationMs) && eventFieldsAreValid(value, schema);
};

interface TimelineCandidate {
  readonly schemaVersion: typeof RECORDING_PRESENTATION_SCHEMA_VERSION;
  readonly recordingId: string;
  readonly episodeId: string;
  readonly clock: RecordingPresentationTimelineV1["clock"];
  readonly sourceCursors: RecordingPresentationSourceCursorsV1;
  readonly initial: RecordingPresentationSnapshotV1;
  readonly events: readonly unknown[];
  readonly assets: readonly RecordingPresentationAssetV1[];
}

const CLOCK_SCHEMA: ObjectSchema = {
  keys: ["origin", "timebase", "durationMs", "captureEpoch", "originAuthorityId"],
  checks: [checkField("origin", literal("capture_ready")), checkField("timebase", literal("recording_relative_ms")), checkField("durationMs", integer()), checkField("captureEpoch", integer(1)), checkField("originAuthorityId", boundedString())],
};

const isClock = (value: unknown): value is RecordingPresentationTimelineV1["clock"] => isExactObject(value, CLOCK_SCHEMA);
const isEventCandidates = (value: unknown): value is readonly unknown[] => Array.isArray(value) && value.length <= RECORDING_PRESENTATION_LIMITS.events;
const isAssets = (value: unknown): value is readonly RecordingPresentationAssetV1[] => isBoundedUniqueArray(value, RECORDING_PRESENTATION_LIMITS.assets, isAsset, (asset) => asset.id);

const TIMELINE_SCHEMA: ObjectSchema = {
  keys: ["schemaVersion", "recordingId", "episodeId", "clock", "sourceCursors", "initial", "events", "assets"],
  checks: [
    checkField("schemaVersion", literal(RECORDING_PRESENTATION_SCHEMA_VERSION)),
    checkField("recordingId", boundedString()),
    checkField("episodeId", boundedString()),
    checkField("clock", isClock),
    checkField("sourceCursors", isSourceCursors),
    checkField("initial", isSnapshot),
    checkField("events", isEventCandidates),
    checkField("assets", isAssets),
  ],
};

const isTimelineCandidate = (value: unknown): value is TimelineCandidate => isExactObject(value, TIMELINE_SCHEMA);

const eventsAreOrdered = (events: readonly unknown[], durationMs: number): events is readonly RecordingPresentationEventV1[] => {
  let previousAtMs = -1;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!isEvent(event, durationMs)) return false;
    if (event.sequence !== index + 1) return false;
    if (event.atMs < previousAtMs) return false;
    previousAtMs = event.atMs;
  }
  return true;
};

const optionalAssetId = (assetId: string | undefined): readonly string[] => (assetId === undefined ? [] : [assetId]);
const sharedContentAssetIds = (sharedContent: RecordingSharedContentV1): readonly string[] => (sharedContent.kind === "whiteboard" ? [sharedContent.stateAssetId] : []);

const eventAssetIds = (event: RecordingPresentationEventV1): readonly string[] => {
  switch (event.kind) {
    case "participant_joined":
      return optionalAssetId(event.participant.avatarAssetId);
    case "chat_message_added":
      return event.message.attachments.map((attachment) => attachment.assetId);
    case "shared_content_changed":
      return sharedContentAssetIds(event.sharedContent);
    default:
      return [];
  }
};

const referencedAssetIds = (initial: RecordingPresentationSnapshotV1, events: readonly RecordingPresentationEventV1[]): readonly string[] => [
  ...initial.profile.fontAssetIds,
  ...optionalAssetId(initial.space.logoAssetId),
  ...initial.participants.flatMap((participant) => optionalAssetId(participant.avatarAssetId)),
  ...initial.chat.messages.flatMap((message) => message.attachments.map((attachment) => attachment.assetId)),
  ...sharedContentAssetIds(initial.sharedContent),
  ...events.flatMap(eventAssetIds),
];

const assetsResolve = (initial: RecordingPresentationSnapshotV1, events: readonly RecordingPresentationEventV1[], assets: readonly RecordingPresentationAssetV1[]): boolean => {
  const assetIds = new Set(assets.map((asset) => asset.id));
  return referencedAssetIds(initial, events).every((id) => assetIds.has(id));
};

const currentSourcesAreValid = (sources: ReadonlyMap<string, RecordingMediaSourceV1>, sharedContent: RecordingSharedContentV1): boolean => {
  const currentSources = [...sources.values()];
  if (!visibleSourcesAreUnambiguous(currentSources)) return false;
  return screenShareResolves(sharedContent, currentSources);
};

const mediaSequenceIsValid = (initial: RecordingPresentationSnapshotV1, events: readonly RecordingPresentationEventV1[]): boolean => {
  const sources = new Map(initial.media.map((source) => [source.sourceId, source]));
  let sharedContent = initial.sharedContent;
  for (const event of events) {
    if (event.kind === "media_source_changed") sources.set(event.source.sourceId, event.source);
    if (event.kind === "shared_content_changed") sharedContent = event.sharedContent;
    if (!currentSourcesAreValid(sources, sharedContent)) return false;
  }
  return true;
};

export const isRecordingPresentationTimelineV1 = (value: unknown): value is RecordingPresentationTimelineV1 => {
  if (!isTimelineCandidate(value)) return false;
  if (value.initial.elapsedMs !== 0) return false;
  const events = value.events;
  if (!eventsAreOrdered(events, value.clock.durationMs)) return false;
  if (!assetsResolve(value.initial, events, value.assets)) return false;
  return mediaSequenceIsValid(value.initial, events);
};

export const parseRecordingPresentationTimelineV1 = (value: unknown): RecordingPresentationTimelineV1 => {
  if (!isRecordingPresentationTimelineV1(value)) throw new TypeError("invalid recording_presentation.v1 timeline");
  return value;
};
