/** Actionable rejection for report text that may contain a credential. */
export class ReportCredentialsError extends Error {
  static readonly code = "reports.credentials_detected";
  readonly code = ReportCredentialsError.code;
  constructor() {
    super("Remove links and codes from your report, display name or call name, then try again. Turn off diagnostics if they contain codes.");
    this.name = "ReportCredentialsError";
  }
}
