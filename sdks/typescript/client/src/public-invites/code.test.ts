import { describe, expect, it } from "vitest";
import { parseInviteCode } from "./code";
import { inviteCodeByShape } from "./code-shape";
import { INVITE_WORD_COUNT } from "./words";

describe("invite code", () => {
  it("reads the same number of words as the generated word list", () => {
    expect(inviteCodeByShape(Array.from({ length: INVITE_WORD_COUNT }, () => "word").join(" "))).toBe(Array.from({ length: INVITE_WORD_COUNT }, () => "word").join("-"));
    expect(inviteCodeByShape(Array.from({ length: INVITE_WORD_COUNT + 1 }, () => "word").join(" "))).toBeUndefined();
  });

  it("accepts only known words in a word code, but any letters in the short forms", () => {
    expect(parseInviteCode("apple.banana.cherry.date")).toBe("apple-banana-cherry-date");
    expect(parseInviteCode("apple.banana.cherry.zzzz")).toBeUndefined();
    expect(inviteCodeByShape("apple.banana.cherry.zzzz")).toBe("apple-banana-cherry-zzzz");
    expect(parseInviteCode("xyz-wxyz-abc")).toBe("xyz-wxyz-abc");
  });

  it.each(["", "apple banana cherry", "apple-banana-cherry-date-fig", "cspi1.aaa.bbb.ccc", "abc.defg.hij", "abc-defg-hi"])("rejects %j", (value) => {
    expect(parseInviteCode(value)).toBeUndefined();
    expect(inviteCodeByShape(value)).toBeUndefined();
  });
});
