import type React from "react";

import { ChalkAlert } from "../chalk-ui";
import { useSkin } from "../skin-context";
import { ClassicCommandErrorAlert } from "./ClassicCommandErrorAlert";

export interface CommandErrorAlertProps {
  readonly message?: string;
}

function ChalkCommandErrorAlert({ message }: CommandErrorAlertProps): React.JSX.Element | null {
  if (!message) return null;

  return (
    <ChalkAlert tone="danger" className="absolute bottom-24 left-1/2 z-40 -translate-x-1/2 px-4 py-2 text-sm text-[var(--chalk-danger)] backdrop-blur">
      {message}
    </ChalkAlert>
  );
}

export function CommandErrorAlert(props: CommandErrorAlertProps): React.JSX.Element | null {
  const skin = useSkin();
  return skin === "classic" ? <ClassicCommandErrorAlert {...props} /> : <ChalkCommandErrorAlert {...props} />;
}
