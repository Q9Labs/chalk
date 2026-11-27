import { expect, it, vi } from "vitest";

async function kindOn(platform: { readonly OS: string; readonly isPad?: boolean }, call: { readonly deviceKind?: string } | undefined) {
  // The native module is read once at import, so each platform gets a fresh copy of the code under test.
  vi.resetModules();
  vi.doMock("react-native", () => ({ Platform: platform, Dimensions: { get: () => ({ width: 390, height: 844 }) }, NativeModules: call ? { ChalkCallService: call } : {} }));
  return (await import("./device-kind")).nativeDeviceKind();
}

it("tells an iPhone from an iPad by Platform.isPad", async () => {
  expect(await kindOn({ OS: "ios", isPad: false }, undefined)).toBe("iphone");
  expect(await kindOn({ OS: "ios", isPad: true }, undefined)).toBe("ipad");
});

it("takes the Android kind from the native call service", async () => {
  expect(await kindOn({ OS: "android" }, { deviceKind: "android_phone" })).toBe("android_phone");
  expect(await kindOn({ OS: "android" }, { deviceKind: "android_tablet" })).toBe("android_tablet");
  expect(await kindOn({ OS: "android" }, { deviceKind: "android_foldable" })).toBe("android_foldable");
});

it("reports an Android phone when the app has not linked the native module", async () => {
  expect(await kindOn({ OS: "android" }, undefined)).toBe("android_phone");
});

it("declares nothing on a platform it does not know", async () => {
  expect(await kindOn({ OS: "tvos" }, undefined)).toBeUndefined();
});
