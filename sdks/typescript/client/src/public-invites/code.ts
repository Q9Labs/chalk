const INVITE_CODE_PATTERN = /^(?:[a-z]{10}|[a-z]{3}-[a-z]{4}-[a-z]{3})$/;

export function parseInviteCode(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  if (!INVITE_CODE_PATTERN.test(normalized)) return undefined;
  const code = normalized.replaceAll("-", "");
  return `${code.slice(0, 3)}-${code.slice(3, 7)}-${code.slice(7)}`;
}
