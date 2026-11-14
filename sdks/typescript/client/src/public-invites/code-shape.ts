const LETTER_CODE_PATTERN = /^(?:[a-z]{10}|[a-z]{3}-[a-z]{4}-[a-z]{3})$/u;
const WORD_CODE_PATTERN = /^[a-z]+(?:[-.\s]+[a-z]+){3}$/u;

/**
 * The normalized invite code a value spells, judged by its shape alone: ten letters, `abc-defg-hij`,
 * or four words split by hyphens, periods or whitespace. It does not check the words, because the word
 * list is large; `parseInviteCode` checks them for typed input. Where the server has already accepted
 * a credential, this is enough. A capability token never has this shape, since it starts with `cspi1`.
 */
export function inviteCodeByShape(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  if (WORD_CODE_PATTERN.test(normalized)) return normalized.split(/[-.\s]+/u).join("-");
  if (!LETTER_CODE_PATTERN.test(normalized)) return undefined;
  const code = normalized.replaceAll("-", "");
  return `${code.slice(0, 3)}-${code.slice(3, 7)}-${code.slice(7)}`;
}
