import { parseDiagnosticReference } from "@q9labsai/diagnostics-contracts";

const alternateReferencePattern = /^[a-z][a-z0-9._-]{0,63}[:/][A-Za-z0-9][A-Za-z0-9_-]{0,159}$/u;

export function isAlternateDiagnosticReference(reference: string): boolean {
  return alternateReferencePattern.test(reference);
}

export function episodeDebuggerPath(input: string): string | undefined {
  const reference = input.trim();
  if (!reference) return undefined;
  try {
    parseDiagnosticReference(reference);
  } catch {
    if (!isAlternateDiagnosticReference(reference)) return undefined;
  }
  return `/developer/episode-diagnostics/${encodeURIComponent(reference)}`;
}
