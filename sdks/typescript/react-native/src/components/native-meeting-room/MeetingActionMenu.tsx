import type { ChalkReaction } from "@q9labsai/chalk-client";
import { useState } from "react";

import { SettingsSheet } from "./SettingsSheet";
import { SpaceMoreSheet } from "./SpaceMoreSheet";
import { SpacePanelSheet } from "./SpacePanelSheet";
import type { SpaceController } from "./space-progressive-surface-types";

export type { SpaceController } from "./space-progressive-surface-types";

export function MeetingActionMenu({ controller }: { readonly controller: SpaceController }): React.JSX.Element {
  const [settingsOpen, setSettingsOpen] = useState(false);
  return (
    <>
      <SpaceMoreSheet controller={controller} onOpenSettings={() => setSettingsOpen(true)} />
      <SettingsSheet controller={controller} isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </>
  );
}

export function MeetingPanel({ controller }: { readonly controller: SpaceController }): React.JSX.Element {
  return <SpacePanelSheet controller={controller} />;
}

export function selectReaction(controller: SpaceController, reaction: string): void {
  controller.sendReaction(reaction as ChalkReaction);
}
