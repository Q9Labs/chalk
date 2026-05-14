import type { JoinSettings } from "../PreJoinLobby";
import type { PostJoinDeviceSelectionKind } from "./useJoinFlowTelemetry";

interface BuildPostJoinDeviceSelectionTasksParams {
  settings: JoinSettings;
  selectMediaDevicePostJoin: (deviceKind: PostJoinDeviceSelectionKind, deviceId: string, select: (id: string) => Promise<void>) => Promise<void>;
  selectCamera: (deviceId: string) => Promise<void>;
  selectMicrophone: (deviceId: string) => Promise<void>;
  selectSpeaker: (deviceId: string) => Promise<void>;
}

export function buildPostJoinDeviceSelectionTasks({ settings, selectMediaDevicePostJoin, selectCamera, selectMicrophone, selectSpeaker }: BuildPostJoinDeviceSelectionTasksParams): Promise<void>[] {
  const tasks: Promise<void>[] = [];

  if (settings.selectedVideoDevice) {
    tasks.push(selectMediaDevicePostJoin("camera", settings.selectedVideoDevice, selectCamera));
  }
  if (settings.selectedAudioInput) {
    tasks.push(selectMediaDevicePostJoin("microphone", settings.selectedAudioInput, selectMicrophone));
  }
  if (settings.selectedAudioOutput) {
    tasks.push(selectMediaDevicePostJoin("speaker", settings.selectedAudioOutput, selectSpeaker));
  }

  return tasks;
}
