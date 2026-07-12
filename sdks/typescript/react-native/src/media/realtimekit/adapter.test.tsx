import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/realtimekit-react-native", () => ({
  default: { init: vi.fn() },
  RealtimeKitProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@cloudflare/react-native-webrtc", () => ({
  RTCRtpReceiver: { getCapabilities: vi.fn() },
  RTCRtpSender: { getCapabilities: vi.fn() },
  mediaDevices: { enumerateDevices: vi.fn() },
}));

vi.mock("react-native", () => ({
  NativeModules: {},
  Platform: { OS: "ios" },
}));

describe("realtimeKitMediaPlaneAdapter", () => {
  it("identifies its provider and extracts only present meetings", async () => {
    const { extractMeeting, realtimeKitMediaPlaneAdapter } = await import("./adapter");
    const meeting = { id: "meeting_123" };

    expect(realtimeKitMediaPlaneAdapter.provider).toBe("cf_rtk");
    expect(realtimeKitMediaPlaneAdapter.extractMeeting({ rtkMeeting: meeting })).toBe(meeting);
    expect(extractMeeting({ rtkMeeting: undefined })).toBeUndefined();
    expect(extractMeeting(undefined)).toBeUndefined();
  });
});
