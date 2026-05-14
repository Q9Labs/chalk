import { useEffect, useState } from "react";

export interface UseLobbyDevicesParams {
  refreshDevices: () => void;
  cameras: ReadonlyArray<{ deviceId?: string }>;
  microphones: ReadonlyArray<{ deviceId?: string }>;
  audioOutputs: ReadonlyArray<{ deviceId?: string }>;
  selectedCamera: string | null;
  selectedMicrophone: string | null;
  selectedSpeaker: string | null;
}

export interface UseLobbyDevicesReturn {
  lobbySelectedCamera: string | undefined;
  setLobbySelectedCamera: (deviceId: string | undefined) => void;
  lobbySelectedMicrophone: string | undefined;
  setLobbySelectedMicrophone: (deviceId: string | undefined) => void;
  lobbySelectedSpeaker: string | undefined;
  setLobbySelectedSpeaker: (deviceId: string | undefined) => void;
}

export function useLobbyDevices({ refreshDevices, cameras, microphones, audioOutputs, selectedCamera, selectedMicrophone, selectedSpeaker }: UseLobbyDevicesParams): UseLobbyDevicesReturn {
  const [lobbySelectedCamera, setLobbySelectedCamera] = useState<string | undefined>(undefined);
  const [lobbySelectedMicrophone, setLobbySelectedMicrophone] = useState<string | undefined>(undefined);
  const [lobbySelectedSpeaker, setLobbySelectedSpeaker] = useState<string | undefined>(undefined);

  useEffect(() => {
    refreshDevices();
  }, [refreshDevices]);

  useEffect(() => {
    if (!lobbySelectedCamera && selectedCamera) {
      setLobbySelectedCamera(selectedCamera);
    }
  }, [lobbySelectedCamera, selectedCamera]);

  useEffect(() => {
    if (!lobbySelectedMicrophone && selectedMicrophone) {
      setLobbySelectedMicrophone(selectedMicrophone);
    }
  }, [lobbySelectedMicrophone, selectedMicrophone]);

  useEffect(() => {
    if (!lobbySelectedSpeaker && selectedSpeaker) {
      setLobbySelectedSpeaker(selectedSpeaker);
    }
  }, [lobbySelectedSpeaker, selectedSpeaker]);

  useEffect(() => {
    if (!lobbySelectedCamera && cameras[0]?.deviceId) {
      setLobbySelectedCamera(cameras[0].deviceId);
    }
  }, [cameras, lobbySelectedCamera]);

  useEffect(() => {
    if (!lobbySelectedMicrophone && microphones[0]?.deviceId) {
      setLobbySelectedMicrophone(microphones[0].deviceId);
    }
  }, [microphones, lobbySelectedMicrophone]);

  useEffect(() => {
    if (!lobbySelectedSpeaker && audioOutputs[0]?.deviceId) {
      setLobbySelectedSpeaker(audioOutputs[0].deviceId);
    }
  }, [audioOutputs, lobbySelectedSpeaker]);

  return {
    lobbySelectedCamera,
    setLobbySelectedCamera,
    lobbySelectedMicrophone,
    setLobbySelectedMicrophone,
    lobbySelectedSpeaker,
    setLobbySelectedSpeaker,
  };
}
