/**
 * useWhatsNew - Hook for What's New dialog state and data fetching
 */

import { useCallback, useEffect, useMemo, useState } from "react";

const STORAGE_PREFIX = "whats-new-seen-v";
const INITIALIZED_KEY = "whats-new-initialized";

export interface WhatsNewData {
	version: string;
	published_at: string;
	title: string;
	content: string;
	image_url?: string;
}

export interface UseWhatsNewOptions {
	/** API base URL (defaults to /api/v1) */
	apiBaseUrl?: string;
	/** Whether to auto-open on new versions */
	autoOpen?: boolean;
}

export interface UseWhatsNewReturn {
	/** The release data */
	data: WhatsNewData | null;
	/** Loading state */
	isLoading: boolean;
	/** Error if fetch failed */
	error: Error | null;
	/** Whether user has seen this version */
	hasSeen: boolean;
	/** Whether dialog should auto-open (new version + user previously initialized) */
	shouldAutoOpen: boolean;
	/** Mark current version as seen */
	markAsSeen: () => void;
	/** Dialog open state */
	isOpen: boolean;
	/** Open the dialog */
	open: () => void;
	/** Close the dialog */
	close: () => void;
}

/**
 * Hook for What's New feature
 *
 * @example
 * ```tsx
 * function WhatsNewButton() {
 *   const { isOpen, open, close, data, hasSeen, markAsSeen, shouldAutoOpen } = useWhatsNew();
 *
 *   useEffect(() => {
 *     if (shouldAutoOpen) open();
 *   }, [shouldAutoOpen, open]);
 *
 *   return (
 *     <>
 *       <button onClick={open}>
 *         What's New {!hasSeen && <span className="badge" />}
 *       </button>
 *       {isOpen && data && (
 *         <WhatsNewDialog
 *           data={data}
 *           onClose={() => { close(); markAsSeen(); }}
 *         />
 *       )}
 *     </>
 *   );
 * }
 * ```
 */
export function useWhatsNew(options: UseWhatsNewOptions = {}): UseWhatsNewReturn {
	const { apiBaseUrl = "/api/v1", autoOpen = true } = options;

	const [data, setData] = useState<WhatsNewData | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<Error | null>(null);
	const [isOpen, setIsOpen] = useState(false);

	// Check if user has seen this specific version
	const hasSeen = useMemo(() => {
		if (!data?.version) return true;
		if (typeof window === "undefined") return true;
		return localStorage.getItem(`${STORAGE_PREFIX}${data.version}`) === "true";
	}, [data?.version]);

	// Check if user has ever dismissed (initialized the feature)
	const isInitialized = useMemo(() => {
		if (typeof window === "undefined") return false;
		return localStorage.getItem(INITIALIZED_KEY) === "true";
	}, []);

	// Only auto-open if: new version + user has seen before (not first-time visitor)
	const shouldAutoOpen = useMemo(() => {
		if (!autoOpen) return false;
		if (!data?.version) return false;
		if (hasSeen) return false;
		if (!isInitialized) return false;
		return true;
	}, [autoOpen, data?.version, hasSeen, isInitialized]);

	// Fetch release data
	useEffect(() => {
		const controller = new AbortController();

		async function fetchRelease() {
			try {
				setIsLoading(true);
				setError(null);

				const response = await fetch(`${apiBaseUrl}/whats-new`, {
					signal: controller.signal,
				});

				if (!response.ok) {
					if (response.status === 404) {
						// No releases - not an error
						setData(null);
						return;
					}
					throw new Error(`Failed to fetch: ${response.status}`);
				}

				const json = await response.json();
				setData(json);
			} catch (err) {
				if (err instanceof Error && err.name !== "AbortError") {
					setError(err);
				}
			} finally {
				setIsLoading(false);
			}
		}

		fetchRelease();

		return () => controller.abort();
	}, [apiBaseUrl]);

	const markAsSeen = useCallback(() => {
		if (!data?.version) return;
		if (typeof window === "undefined") return;

		localStorage.setItem(`${STORAGE_PREFIX}${data.version}`, "true");
		localStorage.setItem(INITIALIZED_KEY, "true");
	}, [data?.version]);

	const open = useCallback(() => setIsOpen(true), []);
	const close = useCallback(() => setIsOpen(false), []);

	return useMemo(
		(): UseWhatsNewReturn => ({
			data,
			isLoading,
			error,
			hasSeen,
			shouldAutoOpen,
			markAsSeen,
			isOpen,
			open,
			close,
		}),
		[data, isLoading, error, hasSeen, shouldAutoOpen, markAsSeen, isOpen, open, close],
	);
}
