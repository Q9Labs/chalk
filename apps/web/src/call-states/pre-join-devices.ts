import { cameraTrack } from "./media";

/** What the fake browser offers before a call: the camera permission, how many microphones exist, and whether the visitor is talking. */
export type FakeDeviceSetup = { readonly permission: PermissionState; readonly microphones: number; readonly talking?: boolean };
const DEFAULT_SETUP: FakeDeviceSetup = { permission: "granted", microphones: 1 };
const MICROPHONE_LABELS = ["MacBook Air Microphone", "Hasan\u2019s AirPods Pro", "Studio Display Microphone"];

/** Replaces getUserMedia, permissions and device listing, after the base harness fakes, so the pre-join step previews a painted camera instead of a real device. */
export function installPreJoinDevices(setup: FakeDeviceSetup = DEFAULT_SETUP): void {
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
