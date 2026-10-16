import React from "react";
import { ClassicSettingsDialog } from "./ClassicSettingsDialog";
import { type SettingsDialogProps } from "./settings-dialog-behavior";

export type { SettingsDialogValue } from "./settings-dialog-behavior";

export const SettingsDialog = React.memo((props: SettingsDialogProps): React.JSX.Element => <ClassicSettingsDialog {...props} />);

SettingsDialog.displayName = "SettingsDialog";
