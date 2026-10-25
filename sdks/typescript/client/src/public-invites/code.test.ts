import { describe, expect, it } from "vitest";

import { parseInviteCode } from "./code";

describe("parseInviteCode", () => {
  it.each([
    ["abc-defg-hij", "abc-defg-hij"],
    ["apple-tiger-lamp-river", "apple-tiger-lamp-river"],
    [" APPLE Tiger.lamp-river ", "apple-tiger-lamp-river"],
    ["apple.tiger.lamp.river", "apple-tiger-lamp-river"],
    ["unknown-tiger-lamp-river", undefined],
    ["hate-tiger-lamp-river", undefined],
    ["apple-tiger-lamp", undefined],
    ["ABCDEFGHIJ", "abc-defg-hij"],
    ["  ABC-DEFG-HIJ  ", "abc-defg-hij"],
    ["abcdefghij", "abc-defg-hij"],
    ["abc-defg-hijk", undefined],
    ["ab-cdefg-hij", undefined],
    ["abc_defg_hij", undefined],
    ["abcdefghi1", undefined],
    ["", undefined],
  ])("parses %j", (value, expected) => {
    expect(parseInviteCode(value)).toBe(expected);
  });
});
