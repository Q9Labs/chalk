import React from "react";
import type { ShareControlPresent } from "./ShareControl";

interface PresentEntryProps {
  readonly onPresent?: () => void;
  readonly presentHint?: string;
  readonly isPresenting?: boolean;
}

/** The Share menu's Present a file entry, absent when this participant can't present. */
export function shareMenuPresent({ onPresent, presentHint, isPresenting }: PresentEntryProps): ShareControlPresent | undefined {
  return onPresent ? { hint: presentHint ?? "", presenting: isPresenting ?? false, onChoose: onPresent } : undefined;
}

/** The phone sheet's Present row label: the action and what the Stage accepts. */
export function PresentSheetLabel({ presentHint, isPresenting }: PresentEntryProps): React.JSX.Element {
  return (
    <span className="flex flex-col text-left">
      <span>{isPresenting ? "Present another file" : "Present a file"}</span>
      {presentHint ? <small>{presentHint}</small> : null}
    </span>
  );
}
