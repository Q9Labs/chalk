import { describe, expect, it } from "vitest";

import { getWhiteboardCamera, withLocalWhiteboardCamera } from "./camera";

describe("whiteboard camera ownership", () => {
  it("keeps the local camera when applying shared scene state", () => {
    const remoteAppState = {
      viewBackgroundColor: "#ffffff",
      scrollX: 900,
      scrollY: 700,
      zoom: { value: 3 },
    };
    const localAppState = { viewBackgroundColor: "#000000", scrollX: 120, scrollY: 80, zoom: { value: 1.25 } };

    expect(withLocalWhiteboardCamera(remoteAppState, localAppState)).toEqual({
      viewBackgroundColor: "#ffffff",
      scrollX: 120,
      scrollY: 80,
      zoom: { value: 1.25 },
    });
    expect(getWhiteboardCamera(localAppState)).toEqual({ scrollX: 120, scrollY: 80, zoom: { value: 1.25 } });
  });
});
