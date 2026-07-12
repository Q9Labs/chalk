import realtimeKitModule, { RealtimeKitProvider } from "@cloudflare/realtimekit-react-native";
import type { ComponentProps } from "react";
import type { MediaPlaneAdapter, MeetingProviderProps, RoomState } from "../media-plane-port";
import { createLoader, type NativePeerConnectionObserver, type NativeRealtimeKit, type OwnedNativeRealtimeKitLoader, type RealtimeKitLoader } from "./loader";
import { resolveMeeting } from "./meeting-lifecycle";

export type NativeRealtimeKitMeeting = ComponentProps<typeof RealtimeKitProvider>["value"];

export function RealtimeKitMeetingProvider({ children, meeting }: MeetingProviderProps<NativeRealtimeKitMeeting>): React.JSX.Element {
  return <RealtimeKitProvider value={meeting}>{children}</RealtimeKitProvider>;
}

export function extractMeeting(room: RoomState | null | undefined): NativeRealtimeKitMeeting | undefined {
  const meeting = room?.rtkMeeting;
  return isNativeRealtimeKitMeeting(meeting) ? meeting : undefined;
}

export const realtimeKitMediaPlaneAdapter: MediaPlaneAdapter<NativeRealtimeKitMeeting, NativeRealtimeKit> = {
  provider: "cf_rtk",
  MeetingProvider: RealtimeKitMeetingProvider,
  extractMeeting,
  resolveMeeting,
  createLoader,
};

function isNativeRealtimeKitMeeting(value: unknown): value is NativeRealtimeKitMeeting {
  return typeof value === "object" && value !== null;
}

export { RealtimeKitProvider, realtimeKitModule };
export type { NativePeerConnectionObserver, NativeRealtimeKit, OwnedNativeRealtimeKitLoader, RealtimeKitLoader };
