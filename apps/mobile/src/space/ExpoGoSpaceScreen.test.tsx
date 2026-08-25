import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requestMultiple: vi.fn(async () => ({
    "android.permission.CAMERA": "granted",
    "android.permission.RECORD_AUDIO": "granted",
  })),
  setState: vi.fn(),
}));

vi.mock("react", () => ({
  useCallback: <T,>(callback: T) => callback,
  useEffect: (effect: () => void) => effect(),
  useState: <T,>(initial: T) => [initial, mocks.setState],
}));
vi.mock("react-native", () => ({
  PermissionsAndroid: {
    PERMISSIONS: { CAMERA: "android.permission.CAMERA", RECORD_AUDIO: "android.permission.RECORD_AUDIO" },
    RESULTS: { GRANTED: "granted" },
    requestMultiple: mocks.requestMultiple,
  },
  Platform: { OS: "android" },
  Pressable: "Pressable",
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: "Text",
  View: "View",
}));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: "SafeAreaView" }));
vi.mock("react-native-webview", () => ({ WebView: "WebView" }));
vi.mock("../components/BrandMark", () => ({ BrandMark: "BrandMark" }));

import { createExpoGoSpaceUrl, ExpoGoSpaceScreen } from "./ExpoGoSpaceScreen";

const route = {
  kind: "space" as const,
  source: "space-link" as const,
  space: "local-space" as const,
  spaceInviteToken: "i".repeat(43),
};

describe("Expo Go in-app Space", () => {
  it("loads the production Space with the display name and invite capability", () => {
    expect(createExpoGoSpaceUrl(route, " Ada Lovelace ")).toBe(`https://chalkmeet.com/space?name=Ada+Lovelace#spaceInviteToken=${"i".repeat(43)}`);
  });

  it("keeps a new local Space free of an invented invite capability", () => {
    expect(createExpoGoSpaceUrl({ kind: "space", source: "local-space", space: "local-space" })).toBe("https://chalkmeet.com/space");
  });

  it("requests Android camera and microphone access before rendering the Space", () => {
    mocks.requestMultiple.mockClear();
    ExpoGoSpaceScreen({ defaultDisplayName: "Ada", onClose: vi.fn(async () => undefined), route });

    expect(mocks.requestMultiple).toHaveBeenCalledWith(["android.permission.CAMERA", "android.permission.RECORD_AUDIO"]);
  });
});
