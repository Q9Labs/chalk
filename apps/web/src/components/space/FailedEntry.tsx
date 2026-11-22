import { CallLimbo } from "@q9labsai/chalk-react";
import type { EntryFailure } from "./entry-failure";

/** The entrance stopped. A refused or expired knock always offers a way home beside asking again; any other retryable failure offers only to try again. */
export function FailedEntry({ failure, spaceName, colorScheme, restarting, onAskAgain }: { readonly failure: EntryFailure; readonly spaceName?: string; readonly colorScheme: "light" | "dark"; readonly restarting: boolean; readonly onAskAgain: () => void }) {
  const askAgain = { label: failure.retryLabel ?? "Ask again", onClick: onAskAgain, disabled: restarting };
  return (
    <CallLimbo
      theme={{ colorScheme }}
      spaceName={spaceName}
      message={failure.message}
      glyph={failure.reason}
      action={failure.retryable && !failure.reason ? askAgain : { label: "Go to Chalk", onClick: () => globalThis.location.assign("/") }}
      secondaryAction={failure.retryable && failure.reason ? { ...askAgain, label: "Ask again" } : undefined}
    />
  );
}
