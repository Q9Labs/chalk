import { useCallback, useRef, useState } from "react";
import { entranceReducer, type Entrance, type EntranceEvent } from "./entrance-machine";

/** The entrance's state and its one way to change it. `send` applies an event at once and says whether it changed anything, so a double click starts one arrival. */
export function useEntrance(initial: () => Entrance) {
  const [entrance, setEntrance] = useState(initial);
  const latest = useRef(entrance);
  const send = useCallback((event: EntranceEvent): boolean => {
    const next = entranceReducer(latest.current, event);
    if (next === latest.current) return false;
    latest.current = next;
    setEntrance(next);
    return true;
  }, []);
  return { entrance, send, latest };
}
