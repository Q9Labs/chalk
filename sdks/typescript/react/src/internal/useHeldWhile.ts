import { useState } from "react";

/** The newest `value` seen while `hold` was false, so a screen can keep showing what it showed until `hold` ends. */
export function useHeldWhile<T>(value: T, hold: boolean): T {
  const [held, setHeld] = useState(value);
  if (!hold && held !== value) setHeld(value);
  return hold ? held : value;
}
