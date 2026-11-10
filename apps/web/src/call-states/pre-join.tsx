import { PreJoinStep } from "./PreJoinStep";
import type { FakeDeviceSetup } from "./pre-join-devices";
import type { Action, CallState } from "./states";

const TALKING: FakeDeviceSetup = { permission: "granted", microphones: 3, talking: true };
const PRE_JOIN_SCENES: readonly { readonly id: string; readonly title: string; readonly devices: FakeDeviceSetup; readonly actions?: readonly Action[]; readonly joining?: boolean }[] = [
  { id: "default", title: "Device check", devices: TALKING },
  { id: "mic-picker", title: "Device check, microphone picker", devices: TALKING, actions: [{ click: "Microphone: MacBook Air Microphone" }] },
  { id: "no-permission", title: "Device check, no permission yet", devices: { permission: "prompt", microphones: 1 } },
  { id: "blocked", title: "Device check, blocked", devices: { permission: "denied", microphones: 1 } },
  { id: "camera-off", title: "Device check, camera off", devices: TALKING, actions: [{ click: "Turn off camera" }] },
  { id: "no-mic", title: "Device check, no microphone", devices: { permission: "granted", microphones: 0 } },
  { id: "joining", title: "Device check, joining", devices: TALKING, joining: true },
];
export const PRE_JOIN_STATES: readonly CallState[] = PRE_JOIN_SCENES.flatMap(({ id, title, devices, actions, joining }) =>
  (["dark", "light"] as const).map((theme) => ({
    id: `prejoin-${id}${theme === "light" ? "-light" : ""}`,
    title: `${title}${theme === "light" ? ", light" : ""}`,
    actions,
    render: () => <PreJoinStep theme={theme} devices={devices} joining={joining === true} />,
  })),
);
