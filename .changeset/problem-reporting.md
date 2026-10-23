---
"@q9labsai/chalk-client": minor
"@q9labsai/chalk-react": minor
---

Add the problem-report API contract and reusable report dialog, with opt-in diagnostics,
editable delivery failures and bounded Unicode input. Call details and failed or ended
call screens can expose reporting when an integration supplies a delivery callback.
Use `reportUnavailableReason` to show expired access inside an editable report.
Live report drafts survive call termination. Integrations with their own terminal
screens can use `onOpenReportProblem` to keep one app-owned dialog across those screens.
Give `ReportProblemDialog` a `focusScope` containing the current call or terminal screen,
so closing it returns focus to its usable opener, or to a visible current control
when the opener has disappeared. Hidden, inert and disabled targets are skipped.
