// Painted canvas tracks stand in for cameras and screens, so every capture of
// a call state shows the same frames on every machine.

const CAMERA_SIZE = { width: 640, height: 360 };
const SCREEN_SIZE = { width: 1280, height: 720 };

const tracks = new Map<string, MediaStreamTrack>();
const painters = new Map<string, ReturnType<typeof setInterval>>();

/** Only releases synthetic source ownership, never SDK-owned clones or contexts. */
export function releaseFakeMedia(): void {
  for (const interval of painters.values()) clearInterval(interval);
  painters.clear();
  for (const track of tracks.values()) track.stop();
  tracks.clear();
}

export function cameraTrack(name: string, background: string): MediaStreamTrack {
  return cachedTrack(`camera:${name}`, CAMERA_SIZE, (context) => paintCamera(context, background));
}

export function screenTrack(): MediaStreamTrack {
  return cachedTrack("screen", SCREEN_SIZE, paintDocument);
}

/** What the fake browser offers before a call: the camera permission, how many microphones exist, and whether the visitor is talking. */
export type FakeDeviceSetup = { readonly permission: PermissionState; readonly microphones: number; readonly talking?: boolean };
const DEFAULT_SETUP: FakeDeviceSetup = { permission: "granted", microphones: 1 };
const MICROPHONE_LABELS = ["MacBook Air Microphone", "Hasan\u2019s AirPods Pro", "Studio Display Microphone"];

/** Replaces getUserMedia, permissions and device listing so the pre-join step previews a painted camera instead of a real device. */
export function installFakeDevices(setup: FakeDeviceSetup = DEFAULT_SETUP): void {
  const mediaDevices = navigator.mediaDevices;
  if (!mediaDevices) return;
  // The step remembers its choice per browser; every state starts from a visitor who has chosen nothing.
  globalThis.localStorage.removeItem("chalk.prejoin-devices");
  Object.defineProperty(navigator, "permissions", { configurable: true, value: { query: async () => ({ state: setup.permission, addEventListener: () => undefined, removeEventListener: () => undefined }) } });
  mediaDevices.getUserMedia = async (constraints) => {
    if (setup.permission === "denied") throw new DOMException("Permission denied", "NotAllowedError");
    if (constraints?.audio && setup.microphones === 0) throw new DOMException("Requested device not found", "NotFoundError");
    const stream = new MediaStream();
    if (constraints?.video) stream.addTrack(cameraTrack("Alex", "#5d6b78").clone());
    if (constraints?.audio) stream.addTrack(audioTrack(setup.talking === true));
    return stream;
  };
  const microphones = MICROPHONE_LABELS.slice(0, setup.microphones).map((label, index) => device("audioinput", index === 0 ? "mic" : `mic-${index}`, label));
  mediaDevices.enumerateDevices = async () => [...microphones, device("videoinput", "cam", "FaceTime HD Camera"), device("audiooutput", "speaker", "MacBook Air Speakers")];
}

function device(kind: MediaDeviceKind, deviceId: string, label: string): MediaDeviceInfo {
  return { kind, deviceId, label, groupId: "call-states", toJSON: () => ({ kind, deviceId, label }) };
}

/** Silence, or a steady tone loud enough to light about half of the pre-join level meter. */
function audioTrack(talking: boolean): MediaStreamTrack {
  const context = new AudioContext();
  const destination = context.createMediaStreamDestination();
  if (talking) {
    const tone = context.createOscillator();
    const volume = context.createGain();
    volume.gain.value = 0.2;
    tone.connect(volume).connect(destination);
    tone.start();
  }
  const [track] = destination.stream.getAudioTracks();
  if (!track) throw new Error("Could not create an audio track for the call-state harness.");
  return track;
}

function cachedTrack(key: string, size: { readonly width: number; readonly height: number }, paint: (context: CanvasRenderingContext2D) => void): MediaStreamTrack {
  const existing = tracks.get(key);
  if (existing) return existing;
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D is unavailable for the call-state harness.");
  paint(context);
  // captureStream only emits frames on change, so repaint the same picture to keep the track live.
  painters.set(
    key,
    setInterval(() => paint(context), 500),
  );
  const [track] = canvas.captureStream(4).getVideoTracks();
  if (!track) throw new Error("Canvas capture produced no video track.");
  tracks.set(key, track);
  return track;
}

function paintCamera(context: CanvasRenderingContext2D, background: string): void {
  const { width, height } = CAMERA_SIZE;
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);
  context.fillStyle = "rgba(255, 255, 255, 0.10)";
  context.fillRect(0, height * 0.62, width, height * 0.38);
  context.fillStyle = "#e9cfb4";
  context.beginPath();
  context.arc(width / 2, height * 0.42, 54, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#2f2a26";
  context.beginPath();
  context.arc(width / 2, height * 0.38, 57, Math.PI, Math.PI * 2);
  context.fill();
  context.fillStyle = "#d8dee6";
  context.beginPath();
  context.ellipse(width / 2, height * 0.95, 120, 80, 0, Math.PI, Math.PI * 2);
  context.fill();
}

function paintDocument(context: CanvasRenderingContext2D): void {
  const { width, height } = SCREEN_SIZE;
  context.fillStyle = "#fbfaf7";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#f1f0eb";
  context.fillRect(0, 0, width, 56);
  context.fillStyle = "#deddd7";
  context.fillRect(0, 56, width, 1);
  for (const [index, color] of ["#d67b7b", "#d9b641", "#80b879"].entries()) {
    context.fillStyle = color;
    context.beginPath();
    context.arc(28 + index * 22, 28, 6, 0, Math.PI * 2);
    context.fill();
  }
  context.fillStyle = "#ffffff";
  context.fillRect(380, 16, 520, 24);
  context.fillStyle = "#858a92";
  context.font = "13px ui-monospace, Menlo, monospace";
  context.textAlign = "center";
  context.fillText("docs.google.com/presentation/q4-plan", 640, 33);
  context.textAlign = "left";
  context.fillStyle = "#0c0e12";
  context.font = "600 40px Figtree, sans-serif";
  context.fillText("Q4 plan", 96, 140);
  context.fillStyle = "#555b65";
  context.font = "16px Figtree, sans-serif";
  context.fillText("Product and engineering, October 17", 96, 172);
  const rows = ["Get Q9 onto real calls every day", "Fix audio after a tab is closed and reopened", "Cut what nobody uses from the call page"];
  for (const [index, line] of rows.entries()) {
    const y = 230 + index * 70;
    context.fillStyle = "#ffffff";
    context.fillRect(96, y, 900, 52);
    context.strokeStyle = "#deddd7";
    context.strokeRect(96.5, y + 0.5, 899, 51);
    context.fillStyle = "#0c0e12";
    context.font = "15px Figtree, sans-serif";
    context.fillText(`${index + 1}.  ${line}`, 120, y + 31);
  }
}
