// Proof-branch diagnostics only: the silence harness reads window.matrixDiag.
export function srDiag(label: string, detail = ""): void {
  const sink = (globalThis as { matrixDiag?: string[] }).matrixDiag;
  sink?.push(`${Date.now()} ${label} ${detail}`);
}

export function srStack(): string {
  return (new Error().stack ?? "")
    .split("\n")
    .slice(2, 7)
    .map((line) => line.trim().replace(/\(.*\/(.*)\)/, "($1)"))
    .join(" < ");
}
