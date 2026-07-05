import type { ReactNode } from "react";

export interface ChalkProviderProps {
  children: ReactNode;
}
export function ChalkProvider({ children }: ChalkProviderProps) {
  return <>{children}</>;
}
const inertSession: any = {
  room: { getRoom: () => null, getState: () => ({}) },
  participants: { getState: () => ({ participants: [], localParticipant: null }) },
  media: { getState: () => ({}) },
  chat: { getState: () => ({}) },
  interactions: { getState: () => ({}) },
  recording: { getState: () => ({}) },
  whiteboard: { getState: () => ({}), on: () => () => {} },
  ui: { getState: () => ({}) },
  screenShare: { getState: () => ({}) },
  getDiagnosticsSnapshot: () => ({}),
  on: () => () => {},
  dispose: () => {},
};
export function useSession(): any {
  return inertSession;
}
export function useChalkSession(): any {
  return {
    session: inertSession,
    join: async () => {},
    joinWithJoinToken: async () => {},
    joinWithInviteLink: async () => {},
    leave: async () => {},
    createSession: async () => "",
    endSession: async () => {},
    removeParticipant: async () => {},
    muteParticipant: () => {},
    unmuteParticipant: () => {},
    isConnected: false,
    rtkMeeting: null,
  };
}
