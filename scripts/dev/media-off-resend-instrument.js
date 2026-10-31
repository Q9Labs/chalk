// Runs before the SDK loads, so every WebSocket and RTCPeerConnection it creates is observed. Fault injection
// lives here, in the page, never in product code.

const NativeWebSocket = window.WebSocket;
const NativePeerConnection = window.RTCPeerConnection;
const nativeCapture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
const syncSockets = [];
const peers = [];
/** Replica of the media projection as Sync sent it to this browser: "participant/source" -> enabled. */
const projection = new Map();
const faults = { dropNextMicrophoneOff: false, droppedFrames: 0, failMediaClose: false, failedMediaCloses: 0 };
const nativeFetch = window.fetch.bind(window);
// Optional second fault: the media plane cannot close the SFU track either, so only Sync can end the publication.
window.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (faults.failMediaClose && url.includes("/tracks/close")) {
    faults.failedMediaCloses += 1;
    return Promise.reject(new TypeError("injected: media close request failed"));
  }
  const path = new URL(url, location.href).pathname.split("/media/").at(-1);
  const entry = { at: Date.now(), path };
  (window.proofFetchLog ??= []).push(entry);
  return nativeFetch(input, init).then(
    (response) => {
      entry.status = response.status;
      return response;
    },
    (error) => {
      entry.status = String(error);
      throw error;
    },
  );
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
  if (window.proofNativeAudio) {
    (window.proofCaptureCalls ??= []).push(Date.now());
    return nativeCapture(constraints);
  }
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

/** Outbound audio on this page: sender track state and what actually left the encoder. */
async function senderStats() {
  const out = [];
  for (const pc of peers) {
    if (pc.connectionState === "closed") continue;
    for (const sender of pc.getSenders()) {
      const track = sender.track;
      if (!track || track.kind !== "audio") continue;
      const item = { track: { id: track.id, enabled: track.enabled, muted: track.muted, readyState: track.readyState }, transceiverDirection: pc.getTransceivers().find((t) => t.sender === sender)?.currentDirection ?? null };
      (await sender.getStats()).forEach((stat) => {
        if (stat.type === "outbound-rtp") Object.assign(item, { packetsSent: stat.packetsSent, bytesSent: stat.bytesSent, active: stat.active });
        if (stat.type === "media-source") Object.assign(item, { sourceAudioLevel: stat.audioLevel, sourceTotalAudioEnergy: stat.totalAudioEnergy });
      });
      out.push(item);
    }
  }
  return out;
}

const analysers = new WeakMap();
/** Receiver side: inbound counters plus a real signal level read from the decoded track over a window. */
async function receiverStats(windowMs = 0) {
  const out = [];
  for (const pc of peers) {
    if (pc.connectionState === "closed") continue;
    for (const receiver of pc.getReceivers()) {
      const track = receiver.track;
      if (track.kind !== "audio" || track.readyState !== "live") continue;
      playRemoteAudio();
      if (!analysers.has(track)) {
        const context = new AudioContext();
        await context.resume();
        const analyser = context.createAnalyser();
        analyser.fftSize = 2048;
        context.createMediaStreamSource(new MediaStream([track])).connect(analyser);
        analysers.set(track, analyser);
      }
      const analyser = analysers.get(track);
      const buffer = new Float32Array(analyser.fftSize);
      let peak = 0;
      let sum = 0;
      let samples = 0;
      const until = Date.now() + windowMs;
      do {
        analyser.getFloatTimeDomainData(buffer);
        let square = 0;
        for (const value of buffer) square += value * value;
        const rms = Math.sqrt(square / buffer.length);
        peak = Math.max(peak, rms);
        sum += rms;
        samples += 1;
        if (windowMs) await new Promise((resolve) => setTimeout(resolve, 50));
      } while (Date.now() < until);
      const item = { track: { id: track.id, muted: track.muted }, rmsPeak: Number(peak.toFixed(5)), rmsMean: Number((sum / samples).toFixed(5)) };
      (await receiver.getStats()).forEach((stat) => {
        if (stat.type === "inbound-rtp" && (stat.kind ?? stat.mediaType) === "audio")
          Object.assign(item, { packetsReceived: stat.packetsReceived, bytesReceived: stat.bytesReceived, totalAudioEnergy: stat.totalAudioEnergy, audioLevel: stat.audioLevel, concealedSamples: stat.concealedSamples, totalSamplesReceived: stat.totalSamplesReceived });
      });
      out.push(item);
    }
  }
  return out;
}

window.proof = {
  faults,
  senderStats,
  receiverStats,
  fetchLog: () => window.proofFetchLog ?? [],
  toneCount: () => (window.proofToneGraphs ?? []).length + (window.proofCaptureCalls ?? []).length,
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
  dropConnection() {
    syncSockets.at(-1).close(4000, "proof: forced reconnect");
  },
};
