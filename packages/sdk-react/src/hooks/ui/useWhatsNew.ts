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
	release_type: "major" | "minor" | "patch";
}

export interface UseWhatsNewOptions {
	/** API base URL (defaults to /api/v1) */
	apiBaseUrl?: string;
	/** Whether to auto-open on new versions */
	autoOpen?: boolean;
}

export interface UseWhatsNewReturn {
	/** The current release data (for backwards compatibility) */
	data: WhatsNewData | null;
	/** All unseen releases */
	releases: WhatsNewData[];
	/** Current position in releases (0-based) */
	currentIndex: number;
	/** Total unseen release count */
	total: number;
	/** Whether there's a next release */
	hasNext: boolean;
	/** Whether there's a previous release */
	hasPrev: boolean;
	/** Go to next release */
	next: () => void;
	/** Go to previous release */
	prev: () => void;
	/** Loading state */
	isLoading: boolean;
	/** Error if fetch failed */
	error: Error | null;
	/** Whether user has seen the current version */
	hasSeen: boolean;
	/** Whether dialog should auto-open (new version + user previously initialized) */
	shouldAutoOpen: boolean;
	/** Mark current version as seen */
	markAsSeen: () => void;
	/** Mark all fetched versions as seen */
	markAllAsSeen: () => void;
	/** Close without marking (later action) */
	later: () => void;
	/** Dialog open state */
	isOpen: boolean;
	/** Open the dialog */
	open: () => void;
	/** Close the dialog */
	close: () => void;
}

/**
 * Check if a version has been seen
 */
function isVersionSeen(version: string): boolean {
	if (typeof window === "undefined") return true;
	return localStorage.getItem(`${STORAGE_PREFIX}${version}`) === "true";
}

/**
 * Mark a version as seen
 */
function markVersionSeen(version: string): void {
	if (typeof window === "undefined") return;
	localStorage.setItem(`${STORAGE_PREFIX}${version}`, "true");
	localStorage.setItem(INITIALIZED_KEY, "true");
}

/**
 * Hook for What's New feature with multi-release navigation
 *
 * @example
 * ```tsx
 * function WhatsNewButton() {
 *   const {
 *     isOpen, open, close, releases, currentIndex, total,
 *     hasNext, hasPrev, next, prev, markAllAsSeen, later
 *   } = useWhatsNew();
 *
 *   return (
 *     <>
 *       <WhatsNewDialog
 *         isOpen={isOpen}
 *         releases={releases}
 *         currentIndex={currentIndex}
 *         onNext={next}
 *         onPrev={prev}
 *         onSkipAll={markAllAsSeen}
 *         onLater={later}
 *         onClose={close}
 *       />
 *     </>
 *   );
 * }
 * ```
 */
export function useWhatsNew(options: UseWhatsNewOptions = {}): UseWhatsNewReturn {
	const { apiBaseUrl = "/api/v1", autoOpen = true } = options;

	const [allReleases, setAllReleases] = useState<WhatsNewData[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<Error | null>(null);
	const [isOpen, setIsOpen] = useState(false);
	const [currentIndex, setCurrentIndex] = useState(0);

	// Filter to only unseen releases
	const releases = useMemo(() => {
		return allReleases.filter((r) => !isVersionSeen(r.version));
	}, [allReleases]);

	// Current release data (for backwards compatibility)
	const data = releases[currentIndex] ?? null;

	// Navigation helpers
	const total = releases.length;
	const hasNext = currentIndex < total - 1;
	const hasPrev = currentIndex > 0;

	// Check if user has seen current version
	const hasSeen = useMemo(() => {
		if (!data?.version) return true;
		return isVersionSeen(data.version);
	}, [data?.version]);

	// Check if user has ever dismissed (initialized the feature)
	const isInitialized = useMemo(() => {
		if (typeof window === "undefined") return false;
		return localStorage.getItem(INITIALIZED_KEY) === "true";
	}, []);

	// Only auto-open if: has unseen releases + user has seen before (not first-time visitor)
	const shouldAutoOpen = useMemo(() => {
		if (!autoOpen) return false;
		if (releases.length === 0) return false;
		if (!isInitialized) return false;
		return true;
	}, [autoOpen, releases.length, isInitialized]);

	// Fetch release data
	useEffect(() => {
		const controller = new AbortController();

		async function fetchReleases() {
			try {
				setIsLoading(true);
				setError(null);

				const response = await fetch(`${apiBaseUrl}/whats-new/releases`, {
					signal: controller.signal,
				});

				if (!response.ok) {
					if (response.status === 404) {
						// No releases - not an error
						setAllReleases([]);
						return;
					}
					throw new Error(`Failed to fetch: ${response.status}`);
				}

				const json = await response.json();
				setAllReleases(json.releases ?? []);
			} catch (err) {
				if (err instanceof Error && err.name !== "AbortError") {
					setError(err);
				}
			} finally {
				setIsLoading(false);
			}
		}

		fetchReleases();

		return () => controller.abort();
	}, [apiBaseUrl]);

	// Reset index when releases change
	useEffect(() => {
		setCurrentIndex(0);
	}, [releases.length]);

	const next = useCallback(() => {
		setCurrentIndex((prev) => Math.min(prev + 1, releases.length - 1));
	}, [releases.length]);

	const prev = useCallback(() => {
		setCurrentIndex((prev) => Math.max(prev - 1, 0));
	}, []);

	const markAsSeen = useCallback(() => {
		if (!data?.version) return;
		markVersionSeen(data.version);
	}, [data?.version]);

	const markAllAsSeen = useCallback(() => {
		for (const release of releases) {
			markVersionSeen(release.version);
		}
		setIsOpen(false);
	}, [releases]);

	const open = useCallback(() => setIsOpen(true), []);
	const close = useCallback(() => setIsOpen(false), []);
	const later = useCallback(() => setIsOpen(false), []);

	return useMemo(
		(): UseWhatsNewReturn => ({
			data,
			releases,
			currentIndex,
			total,
			hasNext,
			hasPrev,
			next,
			prev,
			isLoading,
			error,
			hasSeen,
			shouldAutoOpen,
			markAsSeen,
			markAllAsSeen,
			later,
			isOpen,
			open,
			close,
		}),
		[
			data,
			releases,
			currentIndex,
			total,
			hasNext,
			hasPrev,
			next,
			prev,
			isLoading,
			error,
			hasSeen,
			shouldAutoOpen,
			markAsSeen,
			markAllAsSeen,
			later,
			isOpen,
			open,
			close,
		],
	);
}
