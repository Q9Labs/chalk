import { describe, expect, it } from "vitest";
import { buildChalkInviteLink } from "./build-chalk-invite-link";

describe("buildChalkInviteLink", () => {
  it("builds a canonical Space invite link with the public host", () => {
    expect(buildChalkInviteLink("design-lab", "cspi1.key.payload.signature")).toBe("https://chalkmeet.com/space/design-lab#spaceInviteToken=cspi1.key.payload.signature");
  });

  it("normalizes trailing slashes on custom origins", () => {
    expect(buildChalkInviteLink("design-lab", "cspi1.key.payload.signature", "https://chalk.q9labs.ai/")).toBe("https://chalk.q9labs.ai/space/design-lab#spaceInviteToken=cspi1.key.payload.signature");
  });
});
