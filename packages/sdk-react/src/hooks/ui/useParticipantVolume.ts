export function useParticipantVolume() {
  return { volume: 1, setVolume: (_value: number) => {}, muted: false, setMuted: (_value: boolean) => {} };
}
