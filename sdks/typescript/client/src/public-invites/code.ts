import { INVITE_WORD_COUNT, INVITE_WORDS } from "./words.js";

const INVITE_CODE_PATTERN = /^(?:[a-z]{10}|[a-z]{3}-[a-z]{4}-[a-z]{3})$/;

export function parseInviteCode(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  const words = normalized.split(/[-.\s]+/u);
  if (words.length === INVITE_WORD_COUNT && words.every((word) => INVITE_WORDS.has(word))) return words.join("-");
  if (!INVITE_CODE_PATTERN.test(normalized)) return undefined;
  const code = normalized.replaceAll("-", "");
  return `${code.slice(0, 3)}-${code.slice(3, 7)}-${code.slice(7)}`;
}
