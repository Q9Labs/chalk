import { inviteCodeByShape } from "./code-shape.js";
import { INVITE_WORD_COUNT, INVITE_WORDS } from "./words.js";

export function parseInviteCode(value: string): string | undefined {
  const code = inviteCodeByShape(value);
  if (!code) return undefined;
  const words = code.split("-");
  return words.length !== INVITE_WORD_COUNT || words.every((word) => INVITE_WORDS.has(word)) ? code : undefined;
}
