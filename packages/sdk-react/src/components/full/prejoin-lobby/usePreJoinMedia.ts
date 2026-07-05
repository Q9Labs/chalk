export function usePreJoinMedia(...args: any[]): any {
  const input = args[0] ?? {};
  return { activeVideoTrack: input.videoTrack ?? null, activeAudioTrack: input.audioTrack ?? null, effectiveVideoDevices: input.videoDevices ?? [], effectiveAudioInputDevices: input.audioInputDevices ?? [] };
}
