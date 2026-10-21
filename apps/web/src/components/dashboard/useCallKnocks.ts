import { useEffect, useMemo, useReducer } from "react";

import type { CallPageDTO } from "../../lib/dashboard/contracts";

type Knocks = CallPageDTO["knocks"];
const EMPTY: Knocks = [];

/** Keep accepted decisions hidden while the server's pending projection catches up. */
export function useCallKnocks(spaceId: string, incoming: Knocks | undefined, terminalError = false) {
  const scope = useMemo(() => ({ accepted: new Set<string>(), deciding: new Set<string>(), active: true }), [spaceId]);
  const [, redraw] = useReducer((version: number) => version + 1, 0);
  useEffect(() => {
    scope.active = true;
    return () => {
      scope.active = false;
    };
  }, [scope]);
  useEffect(() => {
    if (terminalError) scope.accepted.clear();
    else if (incoming) {
      const pending = new Set(incoming.map((knock) => knock.handle));
      for (const handle of scope.accepted) if (!pending.has(handle)) scope.accepted.delete(handle);
    }
  }, [scope, incoming, terminalError]);

  async function decide(handle: string, action: () => Promise<void>) {
    if (scope.deciding.has(handle) || scope.accepted.has(handle)) return;
    scope.deciding.add(handle);
    try {
      await action();
      if (!scope.active) return;
      scope.accepted.add(handle);
      redraw();
    } finally {
      scope.deciding.delete(handle);
    }
  }

  return { knocks: (incoming ?? EMPTY).filter((knock) => !scope.accepted.has(knock.handle)), decide };
}
