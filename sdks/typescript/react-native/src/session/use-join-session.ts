import type { ChalkSessionSnapshot, ChalkSessionStore } from "../client-compat";
import { useEffect, useRef } from "react";

export type JoinSessionOptions = {
  readonly session: Pick<ChalkSessionStore, "join">;
  readonly state: ChalkSessionSnapshot["state"];
  readonly onFailure: (error: Error) => void;
  readonly onJoined: (joinedAt: Date) => void;
};

export function useJoinSession(options: JoinSessionOptions): { readonly current: Date | null } {
  const joinedAt = useRef<Date | null>(null);
  const joined = useRef(false);

  useEffect(() => {
    void options.session.join().catch((cause: unknown) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      options.onFailure(error);
    });
  }, [options.onFailure, options.session]);

  useEffect(() => {
    if (options.state !== "live" || joined.current) return;
    joined.current = true;
    joinedAt.current = new Date();
    options.onJoined(joinedAt.current);
  }, [options.onJoined, options.state]);

  return joinedAt;
}
