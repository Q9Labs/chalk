import { describe, expect, it } from "vitest";
import { buildSpaceInviteLink, canonicalSpaceInviteLink, parseChalkInviteLink, parseSpaceInviteLink, verifiedSpaceInviteLink } from "./link";

const token = ["cspi1", "abc_-", "def_-", "ghi_-"].join(".");
const origin = "https://chalkmeet.com";
const longLink = `${origin}/space/team-room#spaceInviteToken=${token}`;

describe("invite links", () => {
  it("reads back the link it builds", () => {
    expect(parseSpaceInviteLink(buildSpaceInviteLink("team-room", token, origin))).toEqual({ slug: "team-room", spaceInviteToken: token });
  });

  it.each([
    ["a link on a Chalk host", longLink],
    ["a bare host and path", `chalkmeet.com/space/team-room#spaceInviteToken=${token}`],
    ["an app link", `chalk://space/team-room#spaceInviteToken=${token}`],
  ])("parses %s", (_name, input) => {
    expect(parseChalkInviteLink(input)).toEqual({ slug: "team-room", spaceInviteToken: token });
  });

  it("parses a short code on its own, in a link and in an app link", () => {
    for (const input of ["abc-defg-hij", `${origin}/abc-defg-hij`, "chalk://abc-defg-hij"]) expect(parseChalkInviteLink(input)).toEqual({ spaceInviteToken: "abc-defg-hij" });
  });

  it.each([
    ["another host", `https://example.test/space/team-room#spaceInviteToken=${token}`],
    ["a token without the capability prefix", `${origin}/space/team-room#spaceInviteToken=nope`],
    ["a short-code link with a fragment", `${origin}/abc-defg-hij#x`],
    ["an empty input", " "],
  ])("rejects %s", (_name, input) => {
    expect(parseChalkInviteLink(input)).toBeNull();
  });

  it("accepts an extra host only when the caller names it", () => {
    const nightly = `https://nightly.chalkmeet.com/space/team-room#spaceInviteToken=${token}`;
    expect(parseChalkInviteLink(nightly)).toBeNull();
    expect(parseChalkInviteLink(nightly, { hosts: ["nightly.chalkmeet.com"] })?.slug).toBe("team-room");
  });
});

describe("link shown to the host", () => {
  it("prefers the short code and keeps a long link that carries its capability", () => {
    expect(canonicalSpaceInviteLink(origin, "team-room", "abc-defg-hij")).toBe(`${origin}/abc-defg-hij`);
    expect(canonicalSpaceInviteLink(origin, "team-room", longLink)).toBe(longLink);
    expect(canonicalSpaceInviteLink(origin, "team-room", token)).toBe(longLink);
  });

  it("refuses a link from another origin", () => {
    expect(() => canonicalSpaceInviteLink(origin, "team-room", `https://evil.test/space/team-room#spaceInviteToken=${token}`)).toThrow("unexpected origin");
  });

  it("verifies a created Space's link against that Space", () => {
    expect(verifiedSpaceInviteLink(origin, "team-room", longLink)).toBe(longLink);
    expect(verifiedSpaceInviteLink(origin, "team-room", `${origin}/abc-defg-hij`)).toBe(`${origin}/abc-defg-hij`);
    expect(() => verifiedSpaceInviteLink(origin, "other-room", longLink)).toThrow("did not match");
    expect(() => verifiedSpaceInviteLink(origin, "team-room", `${origin}/space/team-room#spaceInviteToken=nope`)).toThrow("valid capability");
  });
});
