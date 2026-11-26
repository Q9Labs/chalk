export type EntranceAutoplayInput = {
  readonly autoplayAllowed: boolean;
  readonly automated: boolean;
  readonly reloadMarker: boolean;
  readonly automaticName: string;
  readonly rememberedDevices: boolean;
};

/** Whether entry may skip the lobby. Without autoplay evidence a person's automatic path stops at Join so the click unlocks sound; an automated browser carries no listener and keeps its former unattended entry. */
export function entranceAutoplayDecision({ autoplayAllowed, automated, reloadMarker, automaticName, rememberedDevices }: EntranceAutoplayInput): "resume" | "arrive" | "lobby" {
  if (!autoplayAllowed && !automated) return "lobby";
  if (reloadMarker) return "resume";
  return automaticName && rememberedDevices ? "arrive" : "lobby";
}
