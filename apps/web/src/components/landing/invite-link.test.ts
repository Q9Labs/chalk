import { describe, expect, it } from "vitest";

import { callPathFromLink } from "./invite-link";

const origin = "https://chalkmeet.com";

describe("callPathFromLink", () => {
  it.each([
    ["abc-defg-hij", "/abc-defg-hij"],
    [" APPLE Tiger.lamp-river ", "/apple-tiger-lamp-river"],
    ["https://chalkmeet.com/APPLE.TIGER.LAMP.RIVER", "/apple-tiger-lamp-river"],
    ["https://chalkmeet.com/APPLE%20TIGER%20LAMP%20RIVER", "/apple-tiger-lamp-river"],
    ["ABCDEFGHIJ", "/abc-defg-hij"],
    ["https://chalkmeet.com/ABC-DEFG-HIJ", "/abc-defg-hij"],
    ["/abc-defg-hij", "/abc-defg-hij"],
    ["https://chalkmeet.com/space/q9-team", "/space/q9-team"],
    ["chalkmeet.com/space/q9-team", "/space/q9-team"],
    ["  www.chalkmeet.com/space/q9-team  ", "/space/q9-team"],
    ["/space/q9-team", "/space/q9-team"],
    ["https://chalkmeet.com/space/q9-team#spaceInviteToken=cspi1.abc", "/space/q9-team#spaceInviteToken=cspi1.abc"],
  ])("opens %s on this site", (link, path) => {
    expect(callPathFromLink(link, origin)).toBe(path);
  });

  it("accepts links to the site it runs on", () => {
    expect(callPathFromLink("http://127.0.0.1:3070/space/q9-team", "http://127.0.0.1:3070")).toBe("/space/q9-team");
  });

  it.each(["", "meet.google.com/abc-defg-hij", "https://evil.example/space/q9-team", "//evil.example/space/q9-team", "chalkmeet.com/q9-team", "chalkmeet.com/space/q9-team?token=x", "https://user:pw@chalkmeet.com/space/q9-team", "javascript:alert(1)"])("rejects %s", (link) => {
    expect(callPathFromLink(link, origin)).toBeUndefined();
  });
});
