import { describe, expect, it } from "bun:test";

import packageJson from "../../package.json";
import { getSdkEnvironment } from "../wide-events/environment";

describe("wide-events environment", () => {
  it("uses sdk-core package.json version", () => {
    expect(getSdkEnvironment().version).toBe(packageJson.version);
  });
});
