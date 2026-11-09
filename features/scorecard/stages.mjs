// @ts-check
// Stage ids for the action-latency diagnostics. A stage splits one action into the pieces between two points the
// latency kit can see on the wire, so a slow action shows whether network or server work dominates. Stages never
// feed a budget or a verdict. Add a stage here before the kit records it; the schema rejects unknown ids.

/**
 * @typedef {object} StageSpec
 * @property {string} id  Short name, unique inside its action group.
 * @property {"previous" | "call"} from  "previous": time since the last stage of the chain that was reached (the first one counts from the call).
 *   "call": time since the call started, for a step that runs beside the chain.
 * @property {string} description
 */
/**
 * @typedef {object} StageGroup
 * @property {string} id
 * @property {string} title
 * @property {string} metrics  The action metrics this group splits.
 * @property {StageSpec[]} stages
 */

const prepare = { id: "prepare", from: "previous", description: "call until the Sync command leaves the sender (capture and SDK scheduling)" };
const syncFanout = { id: "sync_fanout", from: "previous", description: "Sync command sent until the roster frame reaches the receiver (uplink, Sync server, downlink)" };
const rosterApply = { id: "roster_apply", from: "previous", description: "roster frame until the receiver's roster shows the change" };
const listPublications = { id: "list_publications", from: "previous", description: "roster change until the receiver's listPublications reply" };
const renegotiate = { id: "renegotiate", from: "previous", description: "previous SFU reply until the receiver's renegotiate reply" };
const syncAck = { id: "sync_ack", from: "call", description: "call until the sender holds Sync's live_target_result" };

/** @param {string} id @param {string} title @param {string} metrics @param {string} source */
const turnOn = (id, title, metrics, source) => ({
  id,
  title,
  metrics,
  stages: [
    prepare,
    syncFanout,
    rosterApply,
    listPublications,
    { id: "pull", from: "previous", description: "listPublications reply until the receiver's pull (tracks) reply" },
    renegotiate,
    { id: "first_media", from: "previous", description: `last reached stage until the receiver gets the first new ${source}` },
    syncAck,
    { id: "sfu_publish", from: "call", description: "call until the sender's tracks reply (publish)" },
  ],
});

/** @param {string} id @param {string} title @param {string} metrics */
const turnOff = (id, title, metrics) => ({
  id,
  title,
  metrics,
  stages: [
    prepare,
    syncFanout,
    rosterApply,
    listPublications,
    { id: "close_tracks", from: "previous", description: "previous reply until the receiver's tracks/close reply" },
    renegotiate,
    { id: "track_removed", from: "previous", description: "last reached stage until the receiver holds no live track" },
    syncAck,
    { id: "sfu_close", from: "call", description: "call until the sender's tracks/close reply" },
  ],
});

/** @type {readonly StageGroup[]} */
export const STAGE_GROUPS = [
  turnOn("mic_on", "Microphone on", "action.mic_toggle.on_ms, action.publish.first_audio_ms", "audio packet"),
  turnOff("mic_off", "Microphone off", "action.mic_toggle.off_ms, action.unpublish.audio_removed_ms"),
  turnOn("camera_on", "Camera on", "action.camera_toggle.on_ms, action.publish.first_frame_ms", "video frame"),
  turnOff("camera_off", "Camera off", "action.camera_toggle.off_ms, action.unpublish.removed_ms"),
  turnOn("screen_start", "Screen share start", "action.screenshare.start_signal_ms, action.screenshare.start_ms", "share frame"),
  turnOff("screen_stop", "Screen share stop", "action.screenshare.stop_signal_ms, action.screenshare.stop_ms"),
  {
    id: "join",
    title: "Join",
    metrics: "action.join.first_audio_ms, action.join.first_video_ms",
    stages: [
      { id: "prepare", from: "previous", description: "join() until the Sync socket is created" },
      { id: "sync_connect", from: "previous", description: "socket created until it is open (TCP, TLS, upgrade)" },
      { id: "sync_welcome", from: "previous", description: "socket open until Sync's welcome frame" },
      { id: "sync_entered", from: "previous", description: "welcome until Sync's entered_ack" },
      { id: "sfu_publications", from: "call", description: "join() until the first listPublications reply" },
      { id: "sfu_tracks", from: "call", description: "join() until the first tracks reply (publish or pull)" },
      { id: "sfu_renegotiate", from: "call", description: "join() until the first renegotiate reply" },
      { id: "ice_connected", from: "call", description: "join() until the first peer connection is connected" },
    ],
  },
];

/** Every stage id the schema accepts, as "<group>.<stage>". */
export const STAGE_IDS = STAGE_GROUPS.flatMap((group) => group.stages.map((stage) => `${group.id}.${stage.id}`));

/**
 * The audio delay a listener adds, estimated from the receiver's WebRTC stats while a call is steady. Informational, like every
 * stage: no budget reads it and it is not a card metric. media.network_jitter_one_way_ms is media.network_ms plus
 * media.jitter_buffer_ms. Capture, encode, SFU forwarding and playout are excluded, so it is not mouth to ear. media.playout_ms
 * is the stream's own playout counter, reported beside it and never added.
 */
export const AUDIO_PARTS = [
  { id: "media.network_jitter_one_way_ms", description: "one-way network time plus listener jitter-buffer delay; capture, encode, SFU forwarding and playout are excluded" },
  { id: "media.network_ms", description: "mean of half the sender's SFU round trip and half the listener's, from each side's selected ICE pair; assumes equal delay each way, and uses the one round trip that was read when the other is missing" },
  { id: "media.jitter_buffer_ms", description: "average time an audio sample waits in the listener's jitter buffer (jitterBufferDelay / jitterBufferEmittedCount)" },
  { id: "media.playout_ms", description: "the inbound audio stream's own totalPlayoutDelay / totalSamplesCount; not part of the total, absent when the browser does not report it, and the device's media-playout stats are not read" },
];
export const AUDIO_KEYS = AUDIO_PARTS.map((part) => part.id);

/** The runner-to-service round trips recorded beside the stages. */
export const RTT_KEYS = /** @type {const} */ (["sfu_ms", "sync_ms"]);
