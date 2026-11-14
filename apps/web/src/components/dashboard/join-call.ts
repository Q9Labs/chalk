import { useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";

const names = new Map<string, string>();
const JOIN_PATH = /^\/dashboard\/call\/([^/]+)\/join\/?$/;

/** The name of a call the dashboard just opened, so the joining card names it from its first frame. */
export const joiningCallName = (spaceId: string): string | undefined => names.get(spaceId);

/**
 * Joining from the dashboard. The join route's code loads while the page is idle, so a click shows the joining card at
 * once instead of waiting on a download, and the call's name travels with the click.
 */
export function useJoinCall(preloadSpaceId?: string): (call: { readonly id: string; readonly name: string }) => void {
  const router = useRouter();
  const navigate = useNavigate();
  useEffect(() => {
    if (!preloadSpaceId) return;
    const preload = () => void router.preloadRoute({ to: "/dashboard/call/$spaceId/join", params: { spaceId: preloadSpaceId } }).catch(() => undefined);
    if (typeof requestIdleCallback === "undefined") {
      const timer = setTimeout(preload, 300);
      return () => clearTimeout(timer);
    }
    const handle = requestIdleCallback(preload, { timeout: 2000 });
    return () => cancelIdleCallback(handle);
  }, [router, preloadSpaceId]);
  return (call) => {
    rememberJoiningCall(call);
    void navigate({ to: "/dashboard/call/$spaceId/join", params: { spaceId: call.id } });
  };
}

/** For a plain link to the join route, which navigates by itself. */
export function rememberJoiningCall(call: { readonly id: string; readonly name: string }): void {
  names.set(call.id, call.name);
}

/**
 * The call a Join press is opening while the join route still loads, so the pressed control shows it is working from
 * the next frame instead of sitting unchanged until the call page paints.
 */
export function usePendingJoin(): string | null {
  return useRouterState({ select: (state) => (state.status === "pending" ? (JOIN_PATH.exec(state.location.pathname)?.[1] ?? null) : null) });
}
