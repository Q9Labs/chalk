import type { OfflineActionsPolicy } from "@q9labsai/chalk-client";
import React from "react";

import { ChalkRadio } from "../chalk-ui";
import { useOfflineActionsPolicy } from "./offline-actions-policy";

const OPTIONS: readonly { readonly value: OfflineActionsPolicy; readonly label: string }[] = [
  { value: "ask", label: "Ask me each time" },
  { value: "send", label: "Always send them" },
  { value: "discard", label: "Always discard them" },
];

/** Settings field that shows and changes the remembered choice for actions made while offline. */
export function OfflineActionsSetting(): React.JSX.Element {
  const [policy, setPolicy] = useOfflineActionsPolicy();
  return (
    <fieldset className="space-y-2">
      <legend className="sr-only">When you reconnect with actions waiting</legend>
      {OPTIONS.map((option) => (
        <ChalkRadio key={option.value} name="offline-actions-policy" value={option.value} checked={policy === option.value} onChange={() => setPolicy(option.value)} label={option.label} wrapperClassName="flex" />
      ))}
    </fieldset>
  );
}
