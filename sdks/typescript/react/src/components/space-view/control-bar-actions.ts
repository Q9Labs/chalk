import type { Dispatch, SetStateAction } from "react";

export interface SpaceViewControlBarActionOptions {
  readonly choosePresentFiles: () => Promise<void>;
  readonly setReactionPickerOpen: Dispatch<SetStateAction<boolean>>;
  readonly documents: readonly { readonly presenterId: string }[];
  readonly selfId: string | null;
}

/** Present opens the file picker straight away and closes the reaction tray; Present reads as active while this participant presents. */
export function spaceViewControlBarActions({ choosePresentFiles, setReactionPickerOpen, documents, selfId }: SpaceViewControlBarActionOptions) {
  return {
    onPresent: () => {
      setReactionPickerOpen(false);
      void choosePresentFiles();
    },
    isPresenting: documents.some((document) => document.presenterId === selfId),
    onOpenReactions: () => setReactionPickerOpen((current) => !current),
  };
}
