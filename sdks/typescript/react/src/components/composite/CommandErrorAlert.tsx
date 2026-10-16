import type React from "react";
import { ClassicCommandErrorAlert } from "./ClassicCommandErrorAlert";

export interface CommandErrorAlertProps {
  readonly message?: string;
}

export function CommandErrorAlert(props: CommandErrorAlertProps): React.JSX.Element | null {
  return <ClassicCommandErrorAlert {...props} />;
}
