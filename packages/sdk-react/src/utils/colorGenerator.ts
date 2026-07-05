export type ParticipantGradientPreference = any;
export const PARTICIPANT_GRADIENT_PRESETS: any[] = [{ id: "chalk-neutral", label: "Neutral", from: "#64748b", to: "#94a3b8" }];
export function getParticipantInitial(name?: string): string {
  return (name?.trim()?.[0] ?? "?").toUpperCase();
}
export function getParticipantInitials(name?: string): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? getParticipantInitial(name);
  const second = parts[1]?.[0] ?? "";
  return (parts.length > 1 ? first + second : first).toUpperCase();
}
export function getParticipantColor(..._args: any[]): any {
  return { primary: "#64748b", secondary: "#94a3b8", text: "#ffffff", gradientEnd: "#94a3b8" };
}
export function getParticipantGradient(..._args: any[]): string {
  return "linear-gradient(135deg, #64748b, #94a3b8)";
}
export function getParticipantAvatarGradient(..._args: any[]): string {
  return getParticipantGradient();
}
export function getParticipantBorder(..._args: any[]): string {
  return "#cbd5e1";
}
export function getParticipantThemeVariables(..._args: any[]): any {
  return {};
}
export function getParticipantAvatarRecipe(name?: string, ..._args: any[]): any {
  const gradient = getParticipantGradient();
  return { initials: getParticipantInitials(name), gradient, avatarGradient: gradient, darkerAvatarGradient: "linear-gradient(135deg, #334155, #64748b)", color: "#64748b", border: getParticipantBorder(), facehashColors: ["#64748b", "#94a3b8", "#cbd5e1"] };
}
