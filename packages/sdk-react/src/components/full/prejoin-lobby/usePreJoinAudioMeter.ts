export function usePreJoinAudioMeter(...args: any[]): any {
  const input = args[0] ?? {};
  return { audioLevel: input.externalAudioLevel ?? 0 };
}
