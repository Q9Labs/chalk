import { formatFailureReference, type ClientFailure } from "@q9labsai/chalk-client";

/** What "Include diagnostics" adds to a report: the call, its connection status and the error line (code and sync detail). */
export function reportDiagnostics(callName: string, connection: { readonly status: string; readonly lastError?: Pick<ClientFailure, "code" | "sync"> | null }): string {
  return [`Call: ${callName}`, `Status: ${connection.status}`, formatFailureReference(connection.lastError)].filter(Boolean).join("\n");
}
