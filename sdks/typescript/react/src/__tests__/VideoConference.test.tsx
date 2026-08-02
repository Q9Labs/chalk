// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import { VideoConference } from "../components/video-conference/VideoConference";

describe("VideoConference public component", () => {
  it("is exported as a React component", () => {
    expect(typeof VideoConference).toBe("function");
  });
});
