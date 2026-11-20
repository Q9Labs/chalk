// @ts-check
import { broken, containsProgress, records, sameTrack, withUpstream } from "./audio.not_heard.mjs";

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Seat} Seat */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

export const symptom = "audio.cant_hear";
export const expected = "the listener sees inbound audio advance and browser playback advance on the same remote track";

/** @param {Declaration} declaration @param {Seat | null} seat */
export const applies = (declaration, seat) => declaration.kind === "episode" && declaration.features.includes("media") && declaration.seats.length > 1 && seat !== null;

const receiveClaims = new Set(["remote_off", "pull_failed", "subscribed", "inbound_flat", "inbound_flowing", "playing", "autoplay_blocked", "playback_paused"]);
const failures = new Map([
  ["pull_failed", ["audio_subscription", "sdk.audio.subscribe", "the microphone is listed but the listener's pull failed and did not deliver a track", "a successful pull of this microphone during the failure"]],
  ["autoplay_blocked", ["autoplay", "react.audio_output", "inbound RTP advanced but the browser denied play()", "advancing element time in the blocked sample"]],
  ["playback_paused", ["audio_element", "react.audio_output", "inbound RTP advanced but the attached element paused after a successful play()", "advancing element time in the paused sample"]],
]);

/** @param {DecideInput} input @returns {Decision} */
export function decide({ readings, declaration, seat }) {
  if (declaration.kind !== "episode" || seat === null) return { status: "unknown", reason: "no listener declared" };
  const peers = new Set(declaration.seats.filter((peer) => peer.participant !== seat.participant).map((peer) => peer.participant));
  const client = records(readings["audio.client"]).filter((row) => receiveClaims.has(row.claim) && typeof row.value.audio_peer_id === "string" && peers.has(row.value.audio_peer_id) && typeof row.value.audio_track_key === "string");
  const forward = records(readings["audio.forward"]).filter((row) => typeof row.value.audio_peer_id === "string" && peers.has(row.value.audio_peer_id) && typeof row.value.audio_track_key === "string");
  for (const row of client) {
    const failure = failures.get(row.claim);
    if (!failure) continue;
    const finding = broken(row, failure[0], failure[1], failure[2], failure[3]);
    return { ...finding, upstream: row.claim === "pull_failed" ? "unknown" : "witnessed" };
  }

  for (const row of forward) {
    if (row.claim === "ingress_not_forwarded") {
      return { ...broken(row, "sfu_forward", "sfu.audio", "the SFU attempted to forward the microphone but wrote no RTP", "an RTP write to this subscription during the sampled interval"), upstream: "witnessed" };
    }
  }
  for (const flat of client.filter((row) => row.claim === "inbound_flat")) {
    const sent = forward.find((row) => row.claim === "forwarded" && row.value.audio_peer_id === flat.value.audio_peer_id && sameTrack(row, flat) && containsProgress(flat, row));
    if (!sent) continue;
    return withUpstream(broken(flat, "receive_rtp", "unknown", "inbound RTP did not advance while the SFU wrote this subscription", "inbound byte progress in the sampled interval"), sent, "the SFU wrote RTP to this subscription");
  }

  if (readings["audio.client"].kind !== "present" || !readings["audio.client"].complete) {
    return { status: "unknown", reason: "listener audio evidence is incomplete" };
  }
  const active = client.filter((row) => row.claim !== "remote_off");
  if (active.length === 0 || !active.every((row) => client.some((playback) => playback.claim === "playing" && playback.value.audio_peer_id === row.value.audio_peer_id && sameTrack(row, playback) && playback.origin === row.origin && playback.window.to_ms >= row.window.from_ms))) {
    return { status: "unknown", reason: "no advancing playback witnessed for every active remote microphone" };
  }
  return { status: "pass" };
}
