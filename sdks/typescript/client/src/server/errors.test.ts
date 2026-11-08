import { describe, expect, it } from "vitest";

import { errorCode } from "./errors";

describe("errorCode", () => {
  it("keeps media.client_unsupported so an app can tell its user to update", () => {
    const body = { error: { code: "media.client_unsupported", message: "This call needs a newer version of Chalk. Update the app and try again." } };
    expect(errorCode(body)).toBe("media.client_unsupported");
  });
});
