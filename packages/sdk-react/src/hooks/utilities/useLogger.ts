/**
 * useLogger hook for React components
 *
 * Provides component-scoped debug logging that respects
 * the global debug mode setting.
 *
 * @packageDocumentation
 * @module @q9labs/chalk-react/hooks
 */

import { useMemo } from "react";
import {
	createLogger,
	isLoggingEnabled,
	type Logger,
} from "@q9labs/chalk-core";

export interface UseLoggerReturn {
	/** Component-scoped logger instance */
	log: Logger;
	/** Whether debug logging is enabled globally */
	isEnabled: boolean;
}

/**
 * Create a component-scoped logger
 *
 * @param component - Component name for log prefixes
 * @returns Logger instance and enabled state
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const { log, isEnabled } = useLogger('MyComponent');
 *
 *   useEffect(() => {
 *     log.info('Component mounted');
 *     return () => log.info('Component unmounted');
 *   }, [log]);
 *
 *   const handleClick = () => {
 *     log.debug('Button clicked');
 *   };
 *
 *   return <button onClick={handleClick}>Click me</button>;
 * }
 * ```
 */
export function useLogger(component: string): UseLoggerReturn {
	const log = useMemo(() => createLogger(component), [component]);
	const isEnabled = isLoggingEnabled();

	return { log, isEnabled };
}
