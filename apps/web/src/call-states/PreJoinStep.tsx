import { useState } from "react";
import { PreJoin } from "../components/space/pre-join/PreJoin";
import { SPACE_NAME } from "./fixtures";

export default function PreJoinStep({ theme, joining }: { readonly theme: "light" | "dark"; readonly joining: boolean }) {
  const [name, setName] = useState("Hasan Shoaib");
  return (
    <main data-chalk data-chalk-theme={theme} className="h-dvh">
      <PreJoin spaceName={SPACE_NAME} displayName={name} onDisplayNameChange={setName} joining={joining} onJoin={() => undefined} />
    </main>
  );
}
