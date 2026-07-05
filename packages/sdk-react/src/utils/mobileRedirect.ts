export type MobileJoinIntent = any;
export type MobileJoinPlatform = "ios" | "android" | "web" | "unknown";
export function buildPublicJoinLink(joinToken: string, publicAppUrl?: string) {
  return publicAppUrl ? publicAppUrl + "?joinToken=" + encodeURIComponent(joinToken) : "";
}
export function extractJoinTokenFromInviteLink(): string | null {
  return null;
}
export function buildMobileJoinDeepLink(..._args: any[]): string {
  return "";
}
export function buildMobileJoinIntent(..._args: any[]): any {
  return null;
}
export function detectMobileJoinPlatform(..._args: any[]): MobileJoinPlatform {
  return "unknown";
}
export function getMobileJoinStoreUrl(..._args: any[]): string | null {
  return null;
}
export function resolveJoinTokenFromJoinTarget(..._args: any[]): string | null {
  return null;
}
export function resolvePublicAppOrigin(..._args: any[]): string | null {
  return null;
}
