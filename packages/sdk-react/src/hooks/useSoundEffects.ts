export type SoundEffect = string;
export function useSoundEffects(): any {
  return { play: (_name: SoundEffect) => {}, preload: () => {} };
}
