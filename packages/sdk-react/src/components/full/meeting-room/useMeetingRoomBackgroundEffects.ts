export function useMeetingRoomBackgroundEffects(..._args: any[]): any {
  return {
    effects: [],
    backgroundEffects: [],
    selectedEffectId: null,
    selectedBackgroundEffect: { mode: "none" },
    isSupported: false,
    isApplying: false,
    isApplyingBackgroundEffect: false,
    handleSelect: async () => {},
    handleCustomUpload: async () => {},
    apply: async () => {},
    clear: async () => {},
  };
}
