export function useDevices() {
  return {
    devices: [],
    cameras: [],
    microphones: [],
    speakers: [],
    selectedCamera: null,
    selectedMicrophone: null,
    selectedSpeaker: null,
    isLoading: false,
    selectCamera: async (_id: string) => {},
    selectMicrophone: async (_id: string) => {},
    selectSpeaker: async (_id: string) => {},
    refreshDevices: async () => [],
    undoDeviceChange: () => {},
  };
}
