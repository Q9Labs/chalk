import { useChalkSession } from "../context/chalk-native-provider";
import { useChalkSnapshot } from "./useChalkRoomActions";

export interface UseConnectionReturn {
  readonly status: "connecting" | "connected" | "disconnected" | "failed" | "reconnecting";
  readonly isConnected: boolean;
  readonly isJoining: boolean;
  readonly join: () => Promise<void>;
  readonly leave: () => Promise<void>;
  readonly endSession: () => Promise<void>;
}

export function useConnection(): UseConnectionReturn {
  const session = useChalkSession();
  const snapshot = useChalkSnapshot();
  return {
    status: snapshot.state === "joining" ? "connecting" : snapshot.state === "live" ? "connected" : snapshot.state === "reconnecting" ? "reconnecting" : snapshot.state === "failed" ? "failed" : "disconnected",
    isConnected: snapshot.state === "live",
    isJoining: snapshot.state === "joining",
    join: session.join,
    leave: session.leave,
    endSession: session.endSession,
  };
}
