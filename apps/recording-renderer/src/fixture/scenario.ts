import { parseRecordingPresentationTimelineV1, type RecordingMediaSourceV1, type RecordingPresentationAssetV1, type RecordingPresentationEventV1, type RecordingPresentationParticipantV1, type RecordingPresentationReactionV1, type RecordingPresentationTimelineV1 } from "@q9labsai/recording-presentation";

// A heavy Episode for the native compositor: three cameras, speaker changes,
// a screen share with a gap, two whiteboard revisions, reactions, a raised
// hand, a camera turning off, and a late joiner. Dev and benchmark use only.

export const RECORDING_ID = "00000000-0000-4000-8000-000000000201";
export const EPISODE_ID = "00000000-0000-4000-8000-000000000202";
export const ORIGIN_AUTHORITY_ID = "00000000-0000-4000-8000-000000000204";
const SPACE_ID = "00000000-0000-4000-8000-000000000203";
export const PEOPLE = [
  { id: "00000000-0000-4000-8000-000000000211", name: "Avery Chen", hue: 0 },
  { id: "00000000-0000-4000-8000-000000000212", name: "Morgan Diaz", hue: 120 },
  { id: "00000000-0000-4000-8000-000000000213", name: "Riley Okafor", hue: 240 },
] as const;
const LATE_JOINER = { id: "00000000-0000-4000-8000-000000000214", name: "Jordan Park" };
const REACTIONS: readonly RecordingPresentationReactionV1["value"][] = ["👍", "🎉", "❤️", "😂", "😮"];

type EventDraft = RecordingPresentationEventV1 extends infer Event ? (Event extends { readonly sequence: number } ? Omit<Event, "sequence"> : never) : never;

export interface FixtureShape {
  readonly durationMs: number;
  readonly width: number;
  readonly height: number;
  readonly colorScheme: "light" | "dark";
}

export interface FixtureSources {
  readonly cameras: readonly RecordingMediaSourceV1[];
  readonly screen: RecordingMediaSourceV1;
  readonly screenStartMs: number;
  readonly screenEndMs: number;
  /** The state assets of whiteboard revisions 1 and 2. */
  readonly whiteboardAssetIds: readonly [string, string];
}

/** The point `fraction` of the way through the Episode. */
export function momentAt(durationMs: number, fraction: number): number {
  return Math.round(durationMs * fraction);
}

function participant(id: string, displayName: string, joinOrdinal: number, overrides: Partial<RecordingPresentationParticipantV1> = {}): RecordingPresentationParticipantV1 {
  return {
    id,
    displayName,
    joinOrdinal,
    joined: true,
    microphoneMuted: false,
    cameraEnabled: true,
    screenShareEnabled: false,
    speaking: false,
    activeSpeaker: false,
    handRaised: false,
    ...overrides,
  };
}

/** The active speaker rotates every four seconds. */
function speakerEvents(durationMs: number): EventDraft[] {
  const events: EventDraft[] = [];
  let previousSpeaker: string = PEOPLE[0].id;
  for (let atMs = 4_000, turn = 1; atMs < durationMs; atMs += 4_000, turn += 1) {
    const speaker = PEOPLE[turn % PEOPLE.length]!.id;
    events.push({ atMs, kind: "participant_speaking_changed", participantId: previousSpeaker, speaking: false });
    events.push({ atMs, kind: "participant_speaking_changed", participantId: speaker, speaking: true });
    events.push({ atMs, kind: "active_speaker_changed", participantId: speaker });
    previousSpeaker = speaker;
  }
  return events;
}

function reactionEvents(durationMs: number): EventDraft[] {
  const events: EventDraft[] = [];
  for (let atMs = 15_000, index = 0; atMs < durationMs; atMs += 30_000, index += 1) {
    const person = PEOPLE[index % PEOPLE.length]!;
    const reaction = { id: `reaction-${index}`, participantId: person.id, displayName: person.name, value: REACTIONS[index % REACTIONS.length]!, occurredAtMs: atMs, expiresAtMs: Math.min(durationMs, atMs + 4_000) };
    events.push({ atMs, kind: "reaction_added", reaction });
  }
  return events;
}

/** The screen share, both whiteboard revisions, the raised hand, the camera that turns off and the late joiner. */
function sceneEvents(durationMs: number, sources: FixtureSources): EventDraft[] {
  const at = (fraction: number): number => momentAt(durationMs, fraction);
  const { screen, screenStartMs, screenEndMs } = sources;
  const [revisionOne, revisionTwo] = sources.whiteboardAssetIds;
  const presenter = PEOPLE[1].id;
  return [
    { atMs: screenStartMs, kind: "participant_screen_share_changed", participantId: presenter, enabled: true },
    { atMs: screenStartMs, kind: "media_source_changed", source: { ...screen, visible: true } },
    { atMs: screenStartMs, kind: "shared_content_changed", sharedContent: { kind: "screen_share", participantId: presenter, sourceId: screen.sourceId } },
    { atMs: screenEndMs, kind: "shared_content_changed", sharedContent: { kind: "whiteboard", sceneId: "scene-1", revision: 1, stateAssetId: revisionOne } },
    { atMs: screenEndMs, kind: "participant_screen_share_changed", participantId: presenter, enabled: false },
    { atMs: screenEndMs, kind: "media_source_changed", source: { ...screen, visible: false } },
    { atMs: at(0.6), kind: "shared_content_changed", sharedContent: { kind: "whiteboard", sceneId: "scene-1", revision: 2, stateAssetId: revisionTwo } },
    { atMs: at(0.75), kind: "shared_content_changed", sharedContent: { kind: "none" } },
    { atMs: at(0.75), kind: "participant_camera_changed", participantId: PEOPLE[2].id, enabled: false },
    { atMs: at(0.75), kind: "media_source_changed", source: { ...sources.cameras[2]!, visible: false } },
    { atMs: at(0.7), kind: "participant_hand_raised_changed", participantId: presenter, raised: true },
    { atMs: at(0.85), kind: "participant_hand_raised_changed", participantId: presenter, raised: false },
    { atMs: at(0.8), kind: "participant_joined", participant: participant(LATE_JOINER.id, LATE_JOINER.name, 4, { cameraEnabled: false, microphoneMuted: true }) },
  ];
}

export function fixtureTimeline(shape: FixtureShape, sources: FixtureSources, assets: readonly RecordingPresentationAssetV1[]): RecordingPresentationTimelineV1 {
  const { durationMs, colorScheme } = shape;
  const drafts = [...speakerEvents(durationMs), ...reactionEvents(durationMs), ...sceneEvents(durationMs, sources)];
  const events = drafts.sort((left, right) => left.atMs - right.atMs).map((event, index) => ({ ...event, sequence: index + 1 }));
  return parseRecordingPresentationTimelineV1({
    schemaVersion: "recording_presentation.v1",
    recordingId: RECORDING_ID,
    episodeId: EPISODE_ID,
    clock: { origin: "capture_ready", timebase: "recording_relative_ms", captureEpoch: 1, originAuthorityId: ORIGIN_AUTHORITY_ID, durationMs },
    sourceCursors: { episodeControlStartRevision: 1, episodeControlEndRevision: 2, chatStartSequence: 0, chatEndSequence: 0, whiteboardStartRevision: 0, whiteboardEndRevision: 2, capturePlanStartRevision: 1, capturePlanEndRevision: 2 },
    initial: {
      elapsedMs: 0,
      profile: {
        name: "recording-space",
        version: "recording-space.v1",
        viewport: { width: shape.width, height: shape.height, deviceScaleFactor: 1 },
        locale: "en",
        timeZone: "UTC",
        fontAssetIds: [],
        theme: { skin: "classic", colorScheme, palette: colorScheme === "dark" ? "warm-charcoal" : "light", texture: "none", stageBackground: true, generatedAvatars: true },
      },
      space: { id: SPACE_ID, name: "Weekly design review" },
      view: { layout: "grid", sidebar: "chat" },
      participants: PEOPLE.map((person, index) => participant(person.id, person.name, index + 1, { speaking: index === 0, activeSpeaker: index === 0, microphoneMuted: index === 2 })),
      media: [...sources.cameras.map((camera) => ({ ...camera, visible: true })), { ...sources.screen, visible: false }],
      chat: { retainedFloorSequence: null, headSequence: 0, messages: [] },
      sharedContent: { kind: "none" },
      reactions: [],
    },
    events,
    assets,
  });
}
