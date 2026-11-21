import type { RefObject } from "react";
import { chalkThemeStyle } from "../../theme";
import { CallDialog } from "../space-header/CallDialog";
import { ShellStyles } from "../control-bar/ShellStyles";
import type { SurfaceObserver } from "../observed-surface";
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
  unavailableCode,
  observe,
}: {
  readonly diagnostics?: string;
  readonly unavailableReason?: string;
  /** The machine reason behind `unavailableReason`, so `report.dialog` reports `blocked_reason` without reading copy. */
  readonly unavailableCode?: "credential_expired" | "reports_unavailable";
  /** Emits `report.dialog` surface records; the dialog's sender usually carries one as `onReportProblem.observe`. */
  readonly observe?: SurfaceObserver;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onReportProblem: NonNullable<ChalkProps["onReportProblem"]>;
  readonly colorScheme: "light" | "dark";
  readonly focusScope: RefObject<HTMLElement | null>;
}) {
  return (
    <div data-chalk data-chalk-theme={colorScheme} className="chalk-root" style={chalkThemeStyle({ colorScheme }, colorScheme)}>
      <ShellStyles />
      <CallDialog kind="report" open={open} onClose={onClose} onReportProblem={onReportProblem} diagnostics={diagnostics} focusScope={focusScope} unavailableReason={unavailableReason} unavailableCode={unavailableCode} observe={observe} />
    </div>
  );
}
