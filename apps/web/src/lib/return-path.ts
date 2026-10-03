// Temporary scoped build proof; no runtime change.
/** Accepts only same-origin absolute paths so a sign-in link cannot redirect off site. */
export function safeReturnPath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return undefined;
  return value;
}
