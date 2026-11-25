export type EntranceAutoplayInput = {
  readonly autoplayAllowed: boolean;
  readonly reloadMarker: boolean;
  readonly automaticName: string;
  readonly rememberedDevices: boolean;
};

/** Whether entry may skip the lobby. Without autoplay evidence every automatic path stops at Join so the click unlocks sound. */
export function entranceAutoplayDecision({ autoplayAllowed, reloadMarker, automaticName, rememberedDevices }: EntranceAutoplayInput): "resume" | "arrive" | "lobby" {
  if (!autoplayAllowed) return "lobby";
  if (reloadMarker) return "resume";
  return automaticName && rememberedDevices ? "arrive" : "lobby";
}
