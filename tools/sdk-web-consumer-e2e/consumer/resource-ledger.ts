import type { ChalkSessionClock, ChalkSessionMediaDevices } from "@q9labsai/chalk-client";

const tracks = new Set<MediaStreamTrack>();
const sockets = new Set<WebSocket>();
const peers = new Set<RTCPeerConnection>();
const timers = new Set<unknown>();

export const fixtureClock: ChalkSessionClock = {
  now: () => Date.now(),
  setTimeout: (callback, milliseconds) => {
    let handle: ReturnType<typeof setTimeout>;
    handle = setTimeout(() => {
      timers.delete(handle);
      callback();
    }, milliseconds);
    timers.add(handle);
    return handle;
  },
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
    timers.delete(handle);
  },
};

export const fixtureMediaDevices: ChalkSessionMediaDevices = {
  getUserMedia: async (constraints) => {
    const mediaTracks: MediaStreamTrack[] = [];
    if (constraints.audio) mediaTracks.push(createAudioTrack());
    if (constraints.video) mediaTracks.push(createVideoTrack("camera"));
    return new MediaStream(mediaTracks);
  },
  getDisplayMedia: async () => new MediaStream([createVideoTrack("screen")]),
};

export function registerSocket(socket: WebSocket): WebSocket {
  sockets.add(socket);
  socket.addEventListener("close", () => sockets.delete(socket), { once: true });
  return socket;
}

export function registerPeer(peer: RTCPeerConnection): RTCPeerConnection {
  peers.add(peer);
  return peer;
}

export function releasePeer(peer: RTCPeerConnection): void {
  peer.close();
  peers.delete(peer);
}

export function releaseTrack(track: MediaStreamTrack): void {
  track.stop();
}

export function resourceCounts() {
  return {
    tracks: [...tracks].filter((track) => track.readyState === "live").length,
    sockets: [...sockets].filter((socket) => socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN).length,
    peers: [...peers].filter((peer) => peer.connectionState !== "closed").length,
    timers: timers.size,
  };
}

function createVideoTrack(label: string): MediaStreamTrack {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (!context) throw new TypeError("Canvas capture is unavailable");
  context.fillStyle = label === "screen" ? "#ef4444" : "#22c55e";
  context.fillRect(0, 0, canvas.width, canvas.height);
  const track = canvas.captureStream(5).getVideoTracks()[0];
  if (!track) throw new TypeError("Canvas capture did not return a video track");
  tracks.add(track);
  return track;
}

function createAudioTrack(): MediaStreamTrack {
  const context = new AudioContext();
  const oscillator = context.createOscillator();
  const destination = context.createMediaStreamDestination();
  oscillator.connect(destination);
  oscillator.start();
  const track = destination.stream.getAudioTracks()[0];
  if (!track) throw new TypeError("Audio capture did not return a track");
  const stop = track.stop.bind(track);
  track.stop = () => {
    stop();
    oscillator.stop();
    void context.close();
  };
  tracks.add(track);
  return track;
}
