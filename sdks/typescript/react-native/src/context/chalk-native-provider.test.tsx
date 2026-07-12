import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { MediaPlaneAdapter, MeetingProviderProps } from "../media/media-plane-port";

vi.mock("@cloudflare/realtimekit-react-native", () => ({
  default: { init: vi.fn() },
  RealtimeKitProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@cloudflare/react-native-webrtc", () => ({}));

vi.mock("react-native", () => ({
  NativeModules: {},
  Platform: { OS: "android" },
}));

vi.mock("../telemetry", () => ({
  createNativeTelemetry: vi.fn(),
}));

describe("ChalkNativeProvider media plane selection", () => {
  it("uses the RealtimeKit adapter when no mediaPlane is supplied", async () => {
    const { ChalkNativeProvider } = await import("./chalk-native-provider");
    const { realtimeKitMediaPlaneAdapter } = await import("../media/realtimekit");

    const element = ChalkNativeProvider({ apiUrl: "https://api.test", children: null });

    expect(mediaPlaneFromElement(element)).toBe(realtimeKitMediaPlaneAdapter);
  });

  it("honors a supplied adapter", async () => {
    const { ChalkNativeProvider } = await import("./chalk-native-provider");
    const fakeAdapter: MediaPlaneAdapter<{ readonly id: string }> = {
      provider: "fake",
      MeetingProvider: FakeMeetingProvider,
      extractMeeting: () => undefined,
      resolveMeeting: ({ nextMeeting }) => nextMeeting,
      createLoader: () => async () => undefined,
    };

    const element = ChalkNativeProvider({ apiUrl: "https://api.test", children: null, mediaPlane: fakeAdapter });

    expect(mediaPlaneFromElement(element)).toBe(fakeAdapter);
  });
});

function FakeMeetingProvider({ children }: MeetingProviderProps<{ readonly id: string }>): React.JSX.Element {
  return <>{children}</>;
}

function mediaPlaneFromElement(element: unknown): unknown {
  if (typeof element !== "object" || element === null || !("props" in element)) return undefined;
  const props = element.props;
  if (typeof props !== "object" || props === null || !("mediaPlane" in props)) return undefined;
  return props.mediaPlane;
}
