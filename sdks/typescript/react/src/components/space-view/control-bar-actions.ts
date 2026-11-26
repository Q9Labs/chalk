import type { Dispatch, SetStateAction } from "react";

export interface SpaceViewControlBarActionOptions {
  readonly setPresentOpen: Dispatch<SetStateAction<boolean>>;
  readonly setReactionPickerOpen: Dispatch<SetStateAction<boolean>>;
  readonly documents: readonly { readonly presenterId: string }[];
  readonly selfId: string | null;
}

/** The Present and Reactions buttons: opening one closes the other, and Present reads as active while this participant presents. */
export function spaceViewControlBarActions({ setPresentOpen, setReactionPickerOpen, documents, selfId }: SpaceViewControlBarActionOptions) {
  return {
    onPresent: () => {
      setReactionPickerOpen(false);
      setPresentOpen((open) => !open);
    },
    isPresenting: documents.some((document) => document.presenterId === selfId),
    onOpenReactions: () => {
      setPresentOpen(false);
      setReactionPickerOpen((current) => !current);
    },
  };
}
