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
export { CommandErrorAlert };
export type { SpaceLayout, SpacePanel, SpaceViewProps };
