import type { RefObject } from "react";
import { chalkThemeStyle } from "../../theme";
import { CallDialog } from "../space-header/CallDetails";
import { ShellStyles } from "../control-bar/ShellStyles";
import type { ChalkProps } from "./Chalk";

/** The call report form for app-owned terminal screens outside Chalk. */
export function ReportProblemDialog({
  open,
  onClose,
  onReportProblem,
  colorScheme,
  focusScope,
  diagnostics = "",
  unavailableReason,
}: {
  readonly diagnostics?: string;
  readonly unavailableReason?: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onReportProblem: NonNullable<ChalkProps["onReportProblem"]>;
  readonly colorScheme: "light" | "dark";
  readonly focusScope: RefObject<HTMLElement | null>;
}) {
  return (
    <div data-chalk data-chalk-theme={colorScheme} className="chalk-root" style={chalkThemeStyle({ colorScheme }, colorScheme)}>
      <ShellStyles />
      <CallDialog kind="report" open={open} onClose={onClose} onReportProblem={onReportProblem} diagnostics={diagnostics} focusScope={focusScope} unavailableReason={unavailableReason} />
    </div>
  );
}
