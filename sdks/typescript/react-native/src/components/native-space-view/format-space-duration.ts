export function formatSpaceDuration(secondsElapsed: number): string {
  return `${Math.floor(secondsElapsed / 60)}:${String(secondsElapsed % 60).padStart(2, "0")}`;
}
