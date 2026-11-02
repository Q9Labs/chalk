// Page for the LiveKit arm. Exposes the same hooks as silence-repro-page.jsx: a tone as the microphone and srSample() per second.
import { Room, RoomEvent, Track } from "livekit-client";

const frequencyOf = (index) => 300 + index * 70;
let room;
let micPending = false;
window.srElements = {};

function installTone(frequency) {
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const stream = new MediaStream();
    if (constraints.audio) {
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      oscillator.frequency.value = frequency;
      const destination = context.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();
      await context.resume();
      stream.addTrack(destination.stream.getAudioTracks()[0]);
    }
    return stream;
  };
}

window.lkJoin = async ({ url, token, index }) => {
  installTone(frequencyOf(index));
  room = new Room({ adaptiveStream: false, dynacast: false });
  window.lkRoom = room;
  room.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind !== Track.Kind.Audio) return;
    const element = track.attach();
    document.body.appendChild(element);
    window.srElements[track.mediaStreamTrack.id] = element;
    element.play().catch(() => undefined);
  });
  await room.connect(url, token, { autoSubscribe: true });
};

window.lkMic = async (on) => {
  micPending = on;
  try {
    await room.localParticipant.setMicrophoneEnabled(on);
  } finally {
    micPending = false;
  }
};

window.srSample = async () => {
  const remote = [];
  let rtt = null;
  for (const participant of room.remoteParticipants.values()) {
    const publication = participant.getTrackPublication(Track.Source.Microphone);
    if (!publication) continue;
    const track = publication.track;
    const mediaTrack = track?.mediaStreamTrack;
    let inbound = null;
    if (track?.receiver) {
      (await track.receiver.getStats()).forEach((stat) => {
        if (stat.type === "inbound-rtp" && stat.kind === "audio") inbound = { bytes: stat.bytesReceived || 0, packets: stat.packetsReceived || 0, audioLevel: stat.audioLevel ?? null, energy: stat.totalAudioEnergy ?? null };
        if (stat.type === "candidate-pair" && stat.nominated && stat.currentRoundTripTime !== undefined) rtt = stat.currentRoundTripTime * 1000;
      });
    }
    const element = mediaTrack ? window.srElements[mediaTrack.id] : undefined;
    remote.push({
      speaker: Number(participant.identity.slice(1)),
      trackId: mediaTrack?.id ?? null,
      readyState: mediaTrack?.readyState ?? null,
      muted: publication.isMuted,
      inbound,
      element: element ? { bound: element.srcObject?.getAudioTracks()[0]?.id === mediaTrack.id, paused: element.paused, play: "ok" } : null,
    });
  }
  const local = room.localParticipant.getTrackPublication(Track.Source.Microphone);
  const mic = local?.track && !local.isMuted ? "enabled" : micPending ? "requesting" : "disabled";
  const roster = [room.localParticipant, ...room.remoteParticipants.values()].map((participant) => Number(participant.identity.slice(1)));
  return { status: room.state === "connected" ? "live" : room.state, mic, roster, remote, rtt, errors: [] };
};

// Every RTCPeerConnection's local UDP port, for the publisher-drop blackhole.
window.lkPorts = async () => {
  const ports = new Set();
  const receivers = [...room.remoteParticipants.values()].map((p) => p.getTrackPublication(Track.Source.Microphone)?.track?.receiver).filter(Boolean);
  const senders = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.sender ? [room.localParticipant.getTrackPublication(Track.Source.Microphone).track.sender] : [];
  for (const part of [...receivers, ...senders]) {
    const stats = await part.getStats();
    const locals = new Map();
    stats.forEach((stat) => stat.type === "local-candidate" && locals.set(stat.id, stat));
    stats.forEach((stat) => {
      if (stat.type === "candidate-pair" && stat.nominated) {
        const local = locals.get(stat.localCandidateId);
        if (local?.protocol === "udp") ports.add(local.port);
      }
    });
  }
  return [...ports];
};
