import type { ConnectionMediaDevices } from "../session/dependencies";
import { SpaceClientError } from "./errors";

type CaptureSource = "microphone" | "camera";

export class MediaDeviceSelection implements ConnectionMediaDevices {
  readonly #devices: ConnectionMediaDevices;
  #microphoneId: string | null = null;
  #cameraId: string | null = null;

  constructor(devices: ConnectionMediaDevices) {
    this.#devices = devices;
  }

  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
    return this.#devices.getUserMedia(applyDeviceSelection(constraints, this.#microphoneId, this.#cameraId));
  }

  getDisplayMedia(constraints: DisplayMediaStreamOptions): Promise<MediaStream> {
    return this.#devices.getDisplayMedia(constraints);
  }

  enumerateDevices(): Promise<readonly MediaDeviceInfo[]> {
    return this.#devices.enumerateDevices?.() ?? Promise.resolve([]);
  }

  selectCapture(source: CaptureSource, deviceId: string): void {
    requireDeviceId(deviceId);
    if (source === "microphone") this.#microphoneId = deviceId;
    else this.#cameraId = deviceId;
  }

  async selectSpeaker(deviceId: string): Promise<void> {
    requireDeviceId(deviceId);
    if (!this.#devices.selectSpeaker) {
      throw new SpaceClientError({
        code: "environment.unsupported",
        recoverable: false,
        message: "This runtime does not provide an audio-output selection seam",
      });
    }
    await this.#devices.selectSpeaker(deviceId);
  }
}

function applyDeviceSelection(constraints: MediaStreamConstraints, microphoneId: string | null, cameraId: string | null): MediaStreamConstraints {
  return {
    ...constraints,
    audio: selectedConstraint(constraints.audio, microphoneId),
    video: selectedConstraint(constraints.video, cameraId),
  };
}

function selectedConstraint(constraint: boolean | MediaTrackConstraints | undefined, deviceId: string | null): boolean | MediaTrackConstraints | undefined {
  if (deviceId === null || constraint === false || constraint === undefined) return constraint;
  if (constraint === true) return { deviceId: { exact: deviceId } };
  return { ...constraint, deviceId: { exact: deviceId } };
}

function requireDeviceId(deviceId: string): void {
  if (deviceId.trim().length > 0) return;
  throw new SpaceClientError({ code: "media.request_invalid", recoverable: false, message: "A media device ID is required" });
}
