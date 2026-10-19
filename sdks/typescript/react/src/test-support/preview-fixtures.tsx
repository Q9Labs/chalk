"use client";
import { useState } from "react";
import type React from "react";
import type { SpaceClient } from "@q9labsai/chalk-client";
import { CommandErrorAlert } from "../components/composite/CommandErrorAlert";
import type { SpaceLayout } from "../components/chalk/Chalk";
import { SpaceView, type SpacePanel, type SpaceViewProps } from "../components/space-view/SpaceView";
import { ChalkProvider } from "../bindings/context";
import { createPreviewClient } from "./preview-client";
/** The gallery supplies all state and commands; the production Chalk wrapper is never involved. */
export type PreviewSpaceViewProps = SpaceViewProps & {
  readonly client?: SpaceClient;
};
export function PreviewSpaceView({ client, ...props }: PreviewSpaceViewProps): React.JSX.Element {
  const [fallbackClient] = useState(() => createPreviewClient());
  return (
    <ChalkProvider client={client ?? fallbackClient}>
      <SpaceView {...props} />
    </ChalkProvider>
  );
}
export function PreviewJoiningScreen({ displayName, message, supportingMessages = [] }: { readonly displayName?: string; readonly message: string; readonly supportingMessages?: readonly string[] }): React.JSX.Element {
  return (
    <main data-chalk className="chalk-root grid min-h-screen place-items-center bg-[var(--chalk-canvas)] p-6 text-center text-[var(--chalk-text)]">
      <div className="grid max-w-sm gap-3 justify-items-center">
        <p className="text-sm font-semibold" role="status">
          {message}
        </p>
        {displayName ? <p className="text-xs text-[var(--chalk-muted-text)]">Preparing for {displayName}</p> : null}
        {supportingMessages.map((supportingMessage) => (
          <p key={supportingMessage} className="text-xs text-[var(--chalk-muted-text)]">
            {supportingMessage}
          </p>
        ))}
      </div>
    </main>
  );
}
export { CommandErrorAlert };
export type { SpaceLayout, SpacePanel, SpaceViewProps };
