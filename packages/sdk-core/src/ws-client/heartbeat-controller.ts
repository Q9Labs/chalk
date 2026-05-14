export interface HeartbeatTickInput {
  now: number;
  lastPongTime: number;
  timeoutMs: number;
}

export type HeartbeatAction = "ping" | "timeout";

export function getHeartbeatAction({ now, lastPongTime, timeoutMs }: HeartbeatTickInput): HeartbeatAction {
  return now - lastPongTime > timeoutMs ? "timeout" : "ping";
}
