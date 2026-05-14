/**
 * useLogger hook for React components
 *
 * @deprecated Use wide events instead via wideEvents from @q9labs/chalk-core
 *
 * @packageDocumentation
 * @module @q9labs/chalk-react/hooks
 */

import { useMemo } from "react";
import { wideEvents } from "@q9labs/chalk-core";

/** Logger interface (now a no-op) */
export interface Logger {
  debug: (message: string, data?: unknown) => void;
  info: (message: string, data?: unknown) => void;
  warn: (message: string, data?: unknown) => void;
  error: (message: string, data?: unknown) => void;
}

export interface UseLoggerReturn {
  /** Component-scoped logger instance (no-op, use wide events) */
  log: Logger;
  /** Whether debug logging is enabled globally */
  isEnabled: boolean;
}

/**
 * Create a component-scoped logger
 *
 * @deprecated Use wide events instead. This hook now returns a no-op logger.
 *
 * @param _component - Component name (unused)
 * @returns Logger instance (no-op) and enabled state
 */
export function useLogger(_component: string): UseLoggerReturn {
  const log = useMemo(
    (): Logger => ({
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    }),
    [],
  );

  return { log, isEnabled: wideEvents.isEnabled };
}
