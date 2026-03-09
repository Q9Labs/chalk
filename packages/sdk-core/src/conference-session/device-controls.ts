import type RealtimeKitClient from "@cloudflare/realtimekit";
import { ChalkErrorCode, type ChalkError, type MediaDevice, type MediaDeviceKind, type Participant } from "../types.ts";

interface DeviceControllerDeps {
  getRtkClient: () => RealtimeKitClient | undefined;
  getLocalParticipant: () => Participant | null;
  emitError: (error: ChalkError) => void;
  reapplyBackgroundEffect?: () => Promise<unknown>;
}

export const createConferenceSessionDeviceController = (deps: DeviceControllerDeps) => {
  const getDevices = async (): Promise<MediaDevice[]> => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.map((device) => ({
        deviceId: device.deviceId,
        label: device.label || `${device.kind} (${device.deviceId.slice(0, 8)})`,
        kind: device.kind as MediaDeviceKind,
      }));
    } catch {
      deps.emitError({
        code: ChalkErrorCode.MEDIA_ERROR,
        message: "Failed to list media devices",
      });
      return [];
    }
  };

  const getCameras = async (): Promise<MediaDevice[]> => {
    const devices = await getDevices();
    return devices.filter((device) => device.kind === "videoinput");
  };

  const getMicrophones = async (): Promise<MediaDevice[]> => {
    const devices = await getDevices();
    return devices.filter((device) => device.kind === "audioinput");
  };

  const getSpeakers = async (): Promise<MediaDevice[]> => {
    const devices = await getDevices();
    return devices.filter((device) => device.kind === "audiooutput");
  };

  const selectCamera = async (deviceId: string): Promise<boolean> => {
    const rtkClient = deps.getRtkClient();
    const localParticipant = deps.getLocalParticipant();

    if (!rtkClient || !localParticipant) {
      return false;
    }

    try {
      const self = rtkClient.self as unknown as {
        setDevice?: (kind: string, id: string) => Promise<void>;
        videoTrack?: MediaStreamTrack;
      };

      if (typeof self.setDevice === "function") {
        await self.setDevice("video", deviceId);
      } else {
        if (rtkClient.self.videoEnabled) {
          await rtkClient.self.disableVideo();
        }
        await (rtkClient.self.enableVideo as (opts?: unknown) => Promise<void>)({ videoDevice: deviceId });
      }

      localParticipant.videoEnabled = true;
      localParticipant.videoTrack = (self.videoTrack as MediaStreamTrack | undefined) ?? undefined;
      await deps.reapplyBackgroundEffect?.();
      return true;
    } catch {
      deps.emitError({
        code: ChalkErrorCode.DEVICE_NOT_FOUND,
        message: "Failed to switch camera",
        details: { deviceId },
      });
      return false;
    }
  };

  const selectMicrophone = async (deviceId: string): Promise<boolean> => {
    const rtkClient = deps.getRtkClient();
    const localParticipant = deps.getLocalParticipant();

    if (!rtkClient || !localParticipant) {
      return false;
    }

    try {
      const self = rtkClient.self as unknown as {
        setDevice?: (kind: string, id: string) => Promise<void>;
        audioTrack?: MediaStreamTrack;
      };

      if (typeof self.setDevice === "function") {
        await self.setDevice("audio", deviceId);
      } else {
        if (rtkClient.self.audioEnabled) {
          await rtkClient.self.disableAudio();
        }
        await (rtkClient.self.enableAudio as (opts?: unknown) => Promise<void>)({ audioDevice: deviceId });
      }

      localParticipant.audioEnabled = true;
      localParticipant.audioTrack = (self.audioTrack as MediaStreamTrack | undefined) ?? undefined;
      return true;
    } catch {
      deps.emitError({
        code: ChalkErrorCode.DEVICE_NOT_FOUND,
        message: "Failed to switch microphone",
        details: { deviceId },
      });
      return false;
    }
  };

  return {
    getDevices,
    getCameras,
    getMicrophones,
    getSpeakers,
    selectCamera,
    selectMicrophone,
  };
};
