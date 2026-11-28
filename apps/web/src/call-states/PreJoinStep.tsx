import { useState } from "react";
import { PreJoin } from "../components/space/pre-join/PreJoin";
import { SPACE_NAME } from "./fixtures";
import { installPreJoinDevices, type FakeDeviceSetup } from "./pre-join-devices";

const user = (displayName: string) => ({ displayName, identityKind: "user" as const });
const agent = (displayName: string) => ({ displayName, identityKind: "agent" as const });

export const LOBBY_ROSTERS = {
  ai: [user("Nora Haddad"), agent("Aria"), agent("Scribe")],
  people: [user("Nora Haddad"), user("Tomás Herrera")],
  crowd: [user("Nora Haddad"), user("Tomás Herrera"), user("Priya Raman"), agent("Scribe"), { displayName: "Wen Liu", identityKind: "guest" as const }, user("Aoife Byrne-Castellanos"), user("Kwame Mensah"), agent("Aria"), agent("Recap")],
  nobody: [],
} as const;

export function PreJoinStep({ theme, devices, joining, lobby = "ai" }: { readonly theme: "light" | "dark"; readonly devices: FakeDeviceSetup; readonly joining: boolean; readonly lobby?: keyof typeof LOBBY_ROSTERS }) {
  // The fake browser must be in place before the step asks for the camera. ?browserMedia keeps the real one.
  useState(() => {
    if (!new URLSearchParams(location.search).has("browserMedia")) installPreJoinDevices(devices);
  });
  const [name, setName] = useState("Hasan Shoaib");
  return (
    <main data-chalk data-chalk-theme={theme} className="h-dvh">
      <PreJoin spaceName={SPACE_NAME} displayName={name} onDisplayNameChange={setName} joining={joining} participants={LOBBY_ROSTERS[lobby]} onJoin={() => undefined} />
    </main>
  );
}
