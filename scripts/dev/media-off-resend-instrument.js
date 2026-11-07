// Runs before the SDK loads, so every WebSocket and RTCPeerConnection it creates is observed. Fault injection
// lives here, in the page, never in product code.

const NativeWebSocket = window.WebSocket;
const NativePeerConnection = window.RTCPeerConnection;
const nativeCapture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
const syncSockets = [];
const peers = [];
/** Replica of the media projection as Sync sent it to this browser: "participant/source" -> enabled. */
const projection = new Map();
const faults = { dropNextMicrophoneOff: false, droppedFrames: 0, failMediaClose: false, failedMediaCloses: 0, holdNextPublish: false, heldPublishes: 0 };
let releasePublish;
const nativeFetch = window.fetch.bind(window);
// Optional second fault: the media plane cannot close the SFU track either, so only Sync can end the publication.
window.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  // Holds the next publish request until released: Sync already granted the mic, but no publication exists yet.
  if (faults.holdNextPublish && /\/tracks(\?|$)/u.test(url) && (init?.method ?? "GET") === "POST") {
    faults.holdNextPublish = false;
    faults.heldPublishes += 1;
    return new Promise((resolve, reject) => {
      releasePublish = () => nativeFetch(input, init).then(resolve, reject);
    });
  }
  if (faults.failMediaClose && url.includes("/tracks/close")) {
    faults.failedMediaCloses += 1;
    return Promise.reject(new TypeError("injected: media close request failed"));
  }
  return nativeFetch(input, init);
};
const key = (item) => `${item.participant_id}/${item.source}`;

function observe(data) {
  if (typeof data !== "string") return;
  let frame;
  try {
    frame = JSON.parse(data);
  } catch {
    return;
  }
  if (frame.stream !== "media") return;
  if (frame.type === "projection_snapshot") {
    projection.clear();
    for (const item of frame.items) projection.set(key(item), item.enabled);
  } else if (frame.type === "projection_event") projection.set(key(frame.item), frame.item.enabled);
}

window.WebSocket = class extends NativeWebSocket {
  constructor(...args) {
    super(...args);
    if (!String(args[0]).includes("/v1/sync")) return;
    syncSockets.push(this);
    this.addEventListener("message", (event) => observe(event.data));
  }
  send(data) {
    if (faults.dropNextMicrophoneOff && typeof data === "string") {
      const frame = JSON.parse(data);
      if (frame.type === "live_target" && frame.name === "set_microphone_enabled" && frame.enabled === false) {
        // The connection stays open; this one frame is lost on the way to Sync.
        faults.dropNextMicrophoneOff = false;
        faults.droppedFrames += 1;
        return;
      }
    }
    super.send(data);
  }
};
window.RTCPeerConnection = class extends NativePeerConnection {
  constructor(...args) {
    super(...args);
    peers.push(this);
  }
};

// A steady tone makes "audio flows" measurable as receiver energy.
navigator.mediaDevices.getUserMedia = async (constraints) => {
  const stream = new MediaStream();
  if (constraints.audio) {
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    oscillator.frequency.value = 440;
    const destination = context.createMediaStreamDestination();
    oscillator.connect(destination);
    oscillator.start();
    await context.resume();
    stream.addTrack(destination.stream.getAudioTracks()[0]);
    (window.proofToneGraphs ??= []).push({ context, oscillator, destination });
  }
  if (constraints.video) (await nativeCapture({ video: constraints.video })).getVideoTracks().forEach((track) => stream.addTrack(track));
  return stream;
};

// A receiver only reports audio energy while a sink plays its track, so play every live audio receiver once.
function playRemoteAudio() {
  for (const pc of peers) {
    for (const receiver of pc.getReceivers()) {
      const track = receiver.track;
      if (track.kind !== "audio" || track.readyState !== "live" || playing.has(track)) continue;
      const audio = document.createElement("audio");
      audio.autoplay = true;
      audio.srcObject = new MediaStream([track]);
      document.body.append(audio);
      audio.play().catch(() => undefined);
      playing.add(track);
    }
  }
}
const playing = new WeakSet();
async function receivedAudio() {
  playRemoteAudio();
  let energy = 0;
  let packets = 0;
  for (const pc of peers) {
    if (pc.connectionState === "closed") continue;
    for (const receiver of pc.getReceivers()) {
      if (receiver.track.kind !== "audio" || receiver.track.readyState !== "live") continue;
      (await receiver.getStats()).forEach((stat) => {
        if (stat.type !== "inbound-rtp" || (stat.kind ?? stat.mediaType) !== "audio") return;
        energy += stat.totalAudioEnergy ?? 0;
        packets += stat.packetsReceived ?? 0;
      });
    }
  }
  return { energy, packets };
}

window.proof = {
  faults,
  receivedAudio,
  state() {
    const snapshot = window.proofClient.getSnapshot();
    const socket = syncSockets.at(-1);
    return {
      connection: snapshot.connection.status,
      microphone: snapshot.media.local.microphone.state,
      socketOpen: socket?.readyState === NativeWebSocket.OPEN,
      sockets: syncSockets.length,
      participantId: snapshot.self.participantId,
      projection: Object.fromEntries(projection),
      peers: peers.length,
      toneGraphs: (window.proofToneGraphs ?? []).map((graph) => ({ context: graph.context.state, track: graph.destination.stream.getAudioTracks()[0]?.readyState, enabled: graph.destination.stream.getAudioTracks()[0]?.enabled })),
      remoteAudioTracks: snapshot.media.remote.filter((item) => item.source === "microphone").length,
    };
  },
  async setMicrophone(enabled) {
    const started = Date.now();
    try {
      await window.proofClient.media.setMicrophoneEnabled(enabled);
      return { ok: true, settledAfterMs: Date.now() - started };
    } catch (error) {
      return { ok: false, settledAfterMs: Date.now() - started, error: String(error?.code ?? error?.message ?? error) };
    }
  },
  release() {
    releasePublish?.();
  },
  dropConnection() {
    syncSockets.at(-1).close(4000, "proof: forced reconnect");
  },
};
