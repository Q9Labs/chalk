import type { ComponentType, ReactNode } from "react";
import type { RoomState as ChalkRoomState } from "../internal/core";
import type { NativeRtcPeerConnection } from "../telemetry";

export type RoomState = ChalkRoomState;

export type MeetingTransitionReason = "connected" | "disconnected";

export type MediaPlaneObserver = (peerConnection: NativeRtcPeerConnection) => void | (() => void);

export interface MediaPlaneLoader<TModule = unknown> {
  (): Promise<TModule>;
  dispose?(): void;
}

export interface MeetingProviderProps<TMeeting> {
  readonly children: ReactNode;
  readonly meeting: TMeeting;
}

export type MeetingProvider<TMeeting> = ComponentType<MeetingProviderProps<TMeeting>>;

export interface ResolveMeetingInput<TMeeting> {
  readonly currentMeeting: TMeeting | undefined;
  readonly nextMeeting: TMeeting | undefined;
  readonly reason: MeetingTransitionReason;
}

export interface MediaPlaneAdapter<TMeeting, TModule = unknown> {
  readonly MeetingProvider: MeetingProvider<TMeeting>;
  readonly provider: string;
  extractMeeting(room: RoomState | null | undefined): TMeeting | undefined;
  resolveMeeting(input: ResolveMeetingInput<TMeeting>): TMeeting | undefined;
  createLoader(observer: MediaPlaneObserver): MediaPlaneLoader<TModule>;
}

export type MediaPlanePort<TMeeting, TModule = unknown> = MediaPlaneAdapter<TMeeting, TModule>;
