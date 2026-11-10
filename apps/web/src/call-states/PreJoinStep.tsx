import { useState } from "react";
import { PreJoin } from "../components/space/pre-join/PreJoin";
import { SPACE_NAME } from "./fixtures";
import { installPreJoinDevices, type FakeDeviceSetup } from "./pre-join-devices";

export function PreJoinStep({ theme, devices, joining }: { readonly theme: "light" | "dark"; readonly devices: FakeDeviceSetup; readonly joining: boolean }) {
  // The fake browser must be in place before the step asks for the camera. ?browserMedia keeps the real one.
  useState(() => {
    if (!new URLSearchParams(location.search).has("browserMedia")) installPreJoinDevices(devices);
  });
  const [name, setName] = useState("Hasan Shoaib");
  return (
    <main data-chalk data-chalk-theme={theme} className="h-dvh">
      <PreJoin spaceName={SPACE_NAME} displayName={name} onDisplayNameChange={setName} joining={joining} onJoin={() => undefined} />
    </main>
  );
}
