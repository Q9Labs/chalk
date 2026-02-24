/**
 * usePictureInPicture - Dual-mode Picture-in-Picture hook
 *
 * Two modes:
 * 1. **Auto (tab switch)**: Uses legacy Video PiP API (`video.requestPictureInPicture()`)
 *    which works without user gesture after initial media playback. Shows active speaker only.
 * 2. **Manual (button click)**: Uses Document PiP API for rich UI with controls + self-view.
 *
 * Auto-opens on tab switch, auto-closes on return.
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

const hasDocumentPip =
	typeof window !== "undefined" && "documentPictureInPicture" in window;

const hasLegacyPip =
	typeof document !== "undefined" && "pictureInPictureEnabled" in document;

/**
 * Copies all stylesheets from the main document into the PiP window
 * and watches for dynamically injected styles (Tailwind JIT, CSS-in-JS).
 */
function syncStyles(pipWindow: Window): () => void {
	for (const sheet of document.styleSheets) {
		try {
			const css = Array.from(sheet.cssRules)
				.map((r) => r.cssText)
				.join("\n");
			const style = pipWindow.document.createElement("style");
			style.textContent = css;
			pipWindow.document.head.appendChild(style);
		} catch {
			if (sheet.href) {
				const link = pipWindow.document.createElement("link");
				link.rel = "stylesheet";
				link.href = sheet.href;
				pipWindow.document.head.appendChild(link);
			}
		}
	}

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
	/** PiP window width in px (Document PiP only). Default: 480 */
	width?: number;
	/** PiP window height in px (Document PiP only). Default: 270 */
	height?: number;
	/** Auto-open legacy Video PiP when user switches tabs. Default: true */
	autoOpen?: boolean;
	/** The video track to show in legacy PiP (active speaker). Updated reactively. */
	videoTrack?: MediaStreamTrack | null;
}

export interface UsePictureInPictureReturn {
	/** The Document PiP Window object, or null when not in Document PiP mode */
	pipWindow: Window | null;
	/** Whether any PiP mode is supported */
	isSupported: boolean;
	/** Whether PiP is currently active (either mode) */
	isActive: boolean;
	/** Open Document PiP (requires user gesture) */
	open: () => Promise<void>;
	/** Close any active PiP */
	close: () => void;
	/** Toggle Document PiP on/off (requires user gesture) */
	toggle: () => Promise<void>;
}

export function usePictureInPicture(
	options: UsePictureInPictureOptions = {},
): UsePictureInPictureReturn {
	const { width = 480, height = 270, autoOpen = true, videoTrack = null } = options;

	const [pipWindow, setPipWindow] = useState<Window | null>(null);
	const [isLegacyActive, setIsLegacyActive] = useState(false);
	const cleanupRef = useRef<(() => void) | null>(null);
	const isOpeningRef = useRef(false);
	const videoElRef = useRef<HTMLVideoElement | null>(null);

	// Maintain a hidden video element for legacy PiP
	useEffect(() => {
		if (!hasLegacyPip) return;

		const video = document.createElement("video");
		video.muted = true;
		video.autoplay = true;
		video.playsInline = true;
		// Hidden but must be in DOM for PiP to work
		video.style.position = "fixed";
		video.style.width = "1px";
		video.style.height = "1px";
		video.style.opacity = "0";
		video.style.pointerEvents = "none";
		video.style.zIndex = "-1";
		document.body.appendChild(video);
		videoElRef.current = video;

		return () => {
			video.srcObject = null;
			video.remove();
			videoElRef.current = null;
		};
	}, []);

	// Keep hidden video element in sync with the active speaker track
	useEffect(() => {
		const video = videoElRef.current;
		if (!video) return;

		if (videoTrack && videoTrack.readyState === "live") {
			video.srcObject = new MediaStream([videoTrack]);
			video.play().catch(() => {});
		} else {
			video.srcObject = null;
		}
	}, [videoTrack]);

	// ---------- Document PiP (manual) ----------

	const open = useCallback(async () => {
		if (!hasDocumentPip || isOpeningRef.current) return;
		if (window.documentPictureInPicture?.window) return;

		// Close legacy PiP first if active
		if (document.pictureInPictureElement) {
			await document.exitPictureInPicture().catch(() => {});
			setIsLegacyActive(false);
		}

		isOpeningRef.current = true;
		try {
			const pip = await window.documentPictureInPicture!.requestWindow({
				width,
				height,
				disallowReturnToOpener: true,
			});

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
			// NotAllowedError if no user gesture
		} finally {
			isOpeningRef.current = false;
		}
	}, [width, height]);

	// ---------- Legacy Video PiP (auto on tab switch) ----------

	const openLegacy = useCallback(async () => {
		const video = videoElRef.current;
		if (!video || !hasLegacyPip || !video.srcObject) return;
		if (document.pictureInPictureElement) return;

		try {
			await video.requestPictureInPicture();
			setIsLegacyActive(true);
		} catch {
			// May fail if no eligible video or policy blocks it
		}
	}, []);

	const closeLegacy = useCallback(async () => {
		if (document.pictureInPictureElement) {
			await document.exitPictureInPicture().catch(() => {});
		}
		setIsLegacyActive(false);
	}, []);

	const close = useCallback(() => {
		// Close Document PiP
		pipWindow?.close();
		// Close Legacy PiP
		closeLegacy();
	}, [pipWindow, closeLegacy]);

	const toggle = useCallback(async () => {
		if (pipWindow || isLegacyActive) {
			close();
		} else {
			await open();
		}
	}, [pipWindow, isLegacyActive, open, close]);

	// Listen for legacy PiP exit (user closed via browser chrome)
	useEffect(() => {
		if (!hasLegacyPip) return;

		const handleExit = () => setIsLegacyActive(false);
		document.addEventListener("leavepictureinpicture", handleExit);
		return () => document.removeEventListener("leavepictureinpicture", handleExit);
	}, []);

	// Auto-open/close on tab visibility change
	useEffect(() => {
		if (!autoOpen || !hasLegacyPip) return;

		const handleVisibilityChange = () => {
			if (document.visibilityState === "hidden") {
				// Don't auto-open legacy if Document PiP is already active
				if (pipWindow) return;
				openLegacy();
			} else {
				// User returned to tab — close legacy PiP (not Document PiP)
				if (isLegacyActive) {
					closeLegacy();
				}
			}
		};

		document.addEventListener("visibilitychange", handleVisibilityChange);
		return () =>
			document.removeEventListener("visibilitychange", handleVisibilityChange);
	}, [autoOpen, pipWindow, isLegacyActive, openLegacy, closeLegacy]);

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			cleanupRef.current?.();
			window.documentPictureInPicture?.window?.close();
			if (document.pictureInPictureElement) {
				document.exitPictureInPicture().catch(() => {});
			}
		};
	}, []);

	return {
		pipWindow,
		isSupported: hasDocumentPip || hasLegacyPip,
		isActive: pipWindow !== null || isLegacyActive,
		open,
		close,
		toggle,
	};
}
