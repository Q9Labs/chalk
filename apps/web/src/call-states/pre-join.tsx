import { useState } from "react";
import { PreJoin } from "../components/space/pre-join/PreJoin";
import { SPACE_NAME } from "./fixtures";
import type { FakeDeviceSetup } from "./media";
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
    devices,
    actions,
    render: () => <PreJoinStep theme={theme} joining={joining === true} />,
  })),
);

function PreJoinStep({ theme, joining }: { readonly theme: "light" | "dark"; readonly joining: boolean }) {
  const [name, setName] = useState("Hasan Shoaib");
  return (
    <main data-chalk data-chalk-theme={theme} className="h-dvh">
      <PreJoin spaceName={SPACE_NAME} displayName={name} onDisplayNameChange={setName} joining={joining} onJoin={() => undefined} />
    </main>
  );
}
