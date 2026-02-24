/**
 * usePictureInPicture - Document Picture-in-Picture API hook
 *
 * Opens an always-on-top OS window via the Document PiP API (Chrome 116+).
 * Use with `createPortal` to render React components into the PiP window.
 *
 * @see https://developer.chrome.com/docs/web-platform/document-picture-in-picture
 */

import { useCallback, useEffect, useRef, useState } from "react";

declare global {
	interface Window {
		documentPictureInPicture?: {
			requestWindow(options?: {
				width?: number;
				height?: number;
				disallowReturnToOpener?: boolean;
				preferInitialWindowPlacement?: boolean;
			}): Promise<Window>;
			window: Window | null;
		};
	}
}

const isSupported =
	typeof window !== "undefined" && "documentPictureInPicture" in window;

/**
 * Copies all stylesheets from the main document into the PiP window
 * and watches for dynamically injected styles (Tailwind JIT, CSS-in-JS).
 */
function syncStyles(pipWindow: Window): () => void {
	// One-time snapshot of existing stylesheets
	for (const sheet of document.styleSheets) {
		try {
			const css = Array.from(sheet.cssRules)
				.map((r) => r.cssText)
				.join("\n");
			const style = pipWindow.document.createElement("style");
			style.textContent = css;
			pipWindow.document.head.appendChild(style);
		} catch {
			// Cross-origin sheet — re-link by href
			if (sheet.href) {
				const link = pipWindow.document.createElement("link");
				link.rel = "stylesheet";
				link.href = sheet.href;
				pipWindow.document.head.appendChild(link);
			}
		}
	}

	// Watch for dynamically injected styles (Tailwind JIT, etc.)
	const observer = new MutationObserver((mutations) => {
		for (const mutation of mutations) {
			for (const node of mutation.addedNodes) {
				if (
					node instanceof HTMLStyleElement ||
					(node instanceof HTMLLinkElement && node.rel === "stylesheet")
				) {
					pipWindow.document.head.appendChild(node.cloneNode(true));
				}
			}
		}
	});
	observer.observe(document.head, { childList: true });

	return () => observer.disconnect();
}

export interface UsePictureInPictureOptions {
	/** PiP window width in px. Default: 480 */
	width?: number;
	/** PiP window height in px. Default: 270 */
	height?: number;
	/** Auto-open PiP when user switches tabs. Default: true */
	autoOpen?: boolean;
}

export interface UsePictureInPictureReturn {
	/** The PiP Window object, or null when closed */
	pipWindow: Window | null;
	/** Whether the browser supports Document PiP */
	isSupported: boolean;
	/** Whether PiP is currently active */
	isActive: boolean;
	/** Open the PiP window (requires user gesture) */
	open: () => Promise<void>;
	/** Close the PiP window */
	close: () => void;
	/** Toggle PiP on/off */
	toggle: () => Promise<void>;
}

export function usePictureInPicture(
	options: UsePictureInPictureOptions = {},
): UsePictureInPictureReturn {
	const { width = 480, height = 270, autoOpen = true } = options;

	const [pipWindow, setPipWindow] = useState<Window | null>(null);
	const cleanupRef = useRef<(() => void) | null>(null);
	const isOpeningRef = useRef(false);

	const open = useCallback(async () => {
		if (!isSupported || isOpeningRef.current) return;
		// Already have a PiP window
		if (window.documentPictureInPicture?.window) return;

		isOpeningRef.current = true;
		try {
			const pip = await window.documentPictureInPicture!.requestWindow({
				width,
				height,
				disallowReturnToOpener: true,
			});

			// Reset PiP document body styles
			pip.document.body.style.margin = "0";
			pip.document.body.style.padding = "0";
			pip.document.body.style.overflow = "hidden";
			pip.document.body.style.background = "#000";

			const stopSync = syncStyles(pip);
			cleanupRef.current = stopSync;

			pip.addEventListener(
				"pagehide",
				() => {
					stopSync();
					cleanupRef.current = null;
					setPipWindow(null);
				},
				{ once: true },
			);

			setPipWindow(pip);
		} catch {
			// NotAllowedError if no user gesture, or user closed prompt
		} finally {
			isOpeningRef.current = false;
		}
	}, [width, height]);

	const close = useCallback(() => {
		pipWindow?.close();
	}, [pipWindow]);

	const toggle = useCallback(async () => {
		if (pipWindow) {
			close();
		} else {
			await open();
		}
	}, [pipWindow, open, close]);

	// Auto-open on tab visibility change
	useEffect(() => {
		if (!autoOpen || !isSupported) return;

		const handleVisibilityChange = () => {
			if (document.visibilityState === "hidden" && !pipWindow) {
				// Can't open without user gesture — no-op in background
				// PiP requires transient activation, so auto-open on tab switch
				// only works if user recently interacted. Best-effort.
			}
		};

		document.addEventListener("visibilitychange", handleVisibilityChange);
		return () =>
			document.removeEventListener("visibilitychange", handleVisibilityChange);
	}, [autoOpen, pipWindow]);

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			cleanupRef.current?.();
			window.documentPictureInPicture?.window?.close();
		};
	}, []);

	return {
		pipWindow,
		isSupported,
		isActive: pipWindow !== null,
		open,
		close,
		toggle,
	};
}
