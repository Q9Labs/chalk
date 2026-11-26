export type EntranceAutoplayInput = {
  readonly automaticEntry: boolean;
  readonly reloadMarker: boolean;
  readonly automaticName: string;
  readonly rememberedDevices: boolean;
};

/** Whether entry may skip the lobby. Without autoplay evidence a person's automatic path stops at Join so the click unlocks sound. */
export function entranceAutoplayDecision({ automaticEntry, reloadMarker, automaticName, rememberedDevices }: EntranceAutoplayInput): "resume" | "arrive" | "lobby" {
  if (!automaticEntry) return "lobby";
  if (reloadMarker) return "resume";
  return automaticName && rememberedDevices ? "arrive" : "lobby";
}
