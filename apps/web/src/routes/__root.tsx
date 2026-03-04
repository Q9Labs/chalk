import { createTokenProvider } from "@q9labs/chalk-core";
import {
	ChalkProvider,
	type ChalkPostHogClient,
	useWhatsNew,
	WhatsNewDialog,
	WhatsNewTrigger,
} from "@q9labs/chalk-react";
import {
	createRootRoute,
	HeadContent,
	Outlet,
	Scripts,
} from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { DebugDialog } from "../components/DebugDialog";
import { ErrorProvider } from "../context/error";
import { ThemeProvider } from "../context/theme";
import { installChunkLoadAutoReload } from "../lib/chunkReload";
import { createWebTokenProvider, getApiUrl } from "../lib/internalAuth";

// SSR check - ChalkProvider requires browser APIs
const isServer = typeof window === "undefined";

// If a new deploy removes old hashed chunks, long-lived tabs can start failing
// on route navigation. Auto-reload once on chunk load failures.
installChunkLoadAutoReload();

// import "../../../../packages/sdk-react/src/styles/base.css";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
	head: () => ({
		meta: [
			{
				charSet: "utf-8",
			},
			{
				name: "viewport",
				content: "width=device-width, initial-scale=1",
			},
			{
				title: "Chalk",
			},
		],
		links: [
			{
				rel: "icon",
				type: "image/svg+xml",
				href: "/chalk-icon.svg",
			},
			{
				rel: "stylesheet",
				href: appCss,
			},
		],
	}),

	shellComponent: RootDocument,
	component: RootComponent,
});

function RootDocument({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en">
			<head>
				<HeadContent />
				{import.meta.env.DEV && (
					<script
						src="//unpkg.com/react-grab/dist/index.global.js"
						crossOrigin="anonymous"
					/>
				)}
			</head>
			<body>
				{children}
				<Scripts />
			</body>
		</html>
	);
}

function RootComponent() {
	// API URL for backend - use env var or default to production
	const apiUrl = getApiUrl();
	// WebSocket URL for real-time features (chat, reactions, whiteboard, etc.)
	// Note: Production uses separate subdomain because API Gateway doesn't support
	// mixing HTTP and WebSocket APIs on the same custom domain
	const wsUrl =
		import.meta.env.VITE_WS_URL ||
		(apiUrl
			? (() => {
					const api = new URL(apiUrl);
					// Production: use dedicated WebSocket subdomain (direct to ALB)
					if (api.host === "chalk-api.q9labs.ai") {
						return "wss://chalk-ws.q9labs.ai/ws";
					}
					// Local/other: derive from API URL
					const wsProtocol = api.protocol === "https:" ? "wss:" : "ws:";
					return `${wsProtocol}//${api.host}/ws`;
				})()
			: undefined);

	// Token provider: handles API key → JWT exchange and auto-refresh
	const apiKey = import.meta.env.VITE_CHALK_API_KEY;
	const tokenProvider = useMemo(
		() =>
			apiKey
				? createTokenProvider({
						apiKey,
						apiUrl,
						storage: "sessionStorage",
					})
				: createWebTokenProvider(apiUrl),
		[apiKey, apiUrl],
	);

	const [isDebugOpen, setIsDebugOpen] = useState(false);
	const [posthogClient, setPosthogClient] = useState<
		ChalkPostHogClient | undefined
	>(undefined);

	const posthogKey = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
	const posthogHost =
		(import.meta.env.VITE_POSTHOG_HOST as string | undefined) ||
		"https://us.i.posthog.com";

	useEffect(() => {
		if (isServer || !posthogKey) return;

		let active = true;
		void import("posthog-js")
			.then(({ default: posthog }) => {
				posthog.init(posthogKey, {
					api_host: posthogHost,
					disable_session_recording: true,
				});
				if (active) setPosthogClient(posthog);
			})
			.catch(() => {
				// PostHog is optional for local/dev environments.
			});

		return () => {
			active = false;
		};
	}, [posthogHost, posthogKey]);

	const posthogConfig = useMemo(
		() =>
			posthogClient
				? {
						client: posthogClient,
						properties: {
							app: "web",
						},
					}
				: undefined,
		[posthogClient],
	);

	const content = (
		<ThemeProvider>
			<ErrorProvider>
				<div className="overflow-hidden bg-background text-foreground">
					<Outlet />
					<WhatsNew apiBaseUrl={`${apiUrl}/api/v1`} />

					{/* Version Trigger - Bottom Right */}
					<div className="fixed bottom-4 right-4 z-40 flex flex-col items-end gap-2">
						<button
							onClick={() => setIsDebugOpen(true)}
							className="text-[10px] font-mono text-muted-foreground/50 hover:text-muted-foreground transition-colors cursor-pointer select-none"
							title="System Information"
						>
							v{__APP_VERSION__} ({__COMMIT_HASH__})
						</button>
					</div>

					{!isServer && (
						<DebugDialog
							isOpen={isDebugOpen}
							onClose={() => setIsDebugOpen(false)}
						/>
					)}
				</div>
			</ErrorProvider>
		</ThemeProvider>
	);

	// ChalkProvider requires browser APIs - skip during SSR/prerender
	if (isServer) {
		return content;
	}

	return (
		<ChalkProvider
			debug={true}
			demoMode={false}
			apiUrl={apiUrl}
			wsUrl={wsUrl}
			tokenProvider={tokenProvider}
			posthog={posthogConfig}
		>
			{content}
		</ChalkProvider>
	);
}

function WhatsNew({ apiBaseUrl }: { apiBaseUrl: string }) {
	const {
		isOpen,
		open,
		close,
		releases,
		currentIndex,
		next,
		prev,
		markAllAsSeen,
		later,
		hasSeen,
		shouldAutoOpen,
	} = useWhatsNew({ apiBaseUrl });

	// Auto-open for returning users with unseen updates
	useEffect(() => {
		if (shouldAutoOpen) open();
	}, [shouldAutoOpen, open]);

	return (
		<>
			{/* Floating trigger button - only show when there are unseen releases */}
			{releases.length > 0 && (
				<div className="fixed bottom-4 right-4 z-40">
					<WhatsNewTrigger hasUnseen={!hasSeen} onClick={open} />
				</div>
			)}

			{/* Dialog */}
			{isOpen && releases.length > 0 && (
				<WhatsNewDialog
					isOpen={isOpen}
					onClose={close}
					releases={releases}
					currentIndex={currentIndex}
					onNext={next}
					onPrev={prev}
					onSkipAll={markAllAsSeen}
					onLater={later}
				/>
			)}
		</>
	);
}
