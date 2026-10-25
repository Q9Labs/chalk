import { describe, expect, it } from "vitest";

import { parseChalkInviteLink, parseSpaceInviteLink } from "./invites";

describe("parseChalkInviteLink", () => {
  it.each([
    ["abc-defg-hij", { spaceInviteToken: "abc-defg-hij" }],
    [" APPLE Tiger.lamp-river ", { spaceInviteToken: "apple-tiger-lamp-river" }],
    ["https://chalkmeet.com/APPLE%20TIGER.LAMP-RIVER", { spaceInviteToken: "apple-tiger-lamp-river" }],
    ["chalk://apple-tiger-lamp-river", { spaceInviteToken: "apple-tiger-lamp-river" }],
    ["ABCDEFGHIJ", { spaceInviteToken: "abc-defg-hij" }],
    ["https://chalkmeet.com/abc-defg-hij", { spaceInviteToken: "abc-defg-hij" }],
    ["chalkmeet.com/ABC-DEFG-HIJ", { spaceInviteToken: "abc-defg-hij" }],
    ["chalk://abc-defg-hij", { spaceInviteToken: "abc-defg-hij" }],
    ["http://localhost:3070/abc-defg-hij", { spaceInviteToken: "abc-defg-hij" }],
    ["https://chalkmeet.com/space/design-lab#spaceInviteToken=cspi1.key.payload.signature", { slug: "design-lab", spaceInviteToken: "cspi1.key.payload.signature" }],
  ])("parses %s", (value, expected) => {
    expect(parseChalkInviteLink(value)).toEqual(expected);
  });

  it.each(["https://evil.example/abc-defg-hij", "https://chalkmeet.com/abc-defg-hij?token=x", "abc-defg-hi1", "chalk://space/design-lab"])("rejects %s", (value) => {
    expect(parseChalkInviteLink(value)).toBeNull();
  });

  it("keeps the legacy parser limited to slug links", () => {
    expect(parseSpaceInviteLink("abc-defg-hij")).toBeNull();
    expect(parseSpaceInviteLink("https://chalkmeet.com/abc-defg-hij")).toBeNull();
  });
});
