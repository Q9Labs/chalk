import { describe, expect, it } from "vitest";
import { getWideEventsMemoDependencies } from "./wide-events-config";

describe("getWideEventsMemoDependencies", () => {
  it("treats semantically identical configs as the same dependency tuple", () => {
    const handler = () => {};

    expect(
      getWideEventsMemoDependencies({
        enabled: true,
        includeDebugInfo: true,
        handler,
      }),
    ).toEqual(
      getWideEventsMemoDependencies({
        enabled: true,
        includeDebugInfo: true,
        handler,
      }),
    );
  });

  it("changes when config meaning changes", () => {
    const handler = () => {};

    expect(
      getWideEventsMemoDependencies({
        enabled: true,
        includeDebugInfo: true,
        handler,
      }),
    ).not.toEqual(
      getWideEventsMemoDependencies({
        enabled: false,
        includeDebugInfo: true,
        handler,
      }),
    );

    expect(
      getWideEventsMemoDependencies({
        enabled: true,
        includeDebugInfo: true,
        handler,
      }),
    ).not.toEqual(
      getWideEventsMemoDependencies({
        enabled: true,
        includeDebugInfo: false,
        handler,
      }),
    );

    expect(
      getWideEventsMemoDependencies({
        enabled: true,
        includeDebugInfo: true,
        handler,
      }),
    ).not.toEqual(
      getWideEventsMemoDependencies({
        enabled: true,
        includeDebugInfo: true,
        handler: () => {},
      }),
    );
  });
});
