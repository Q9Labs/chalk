import { createTokenProvider } from "@q9labs/chalk-core";
import { ChalkProvider } from "@q9labs/chalk-react";
import {
	createRootRoute,
	HeadContent,
	Outlet,
	Scripts,
} from "@tanstack/react-router";
import { Moon, Sun } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

// SSR check - ChalkProvider requires browser APIs
const isServer = typeof window === "undefined";

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
			</head>
			<body>
				{children}
				<Scripts />
			</body>
		</html>
	);
}

function RootComponent() {
	const [theme, setTheme] = useState<"dark" | "light">("dark");

	useEffect(() => {
		const root = window.document.documentElement;
		root.classList.remove("light", "dark");
		root.classList.add(theme);
		root.setAttribute("data-chalk-theme", theme);
	}, [theme]);

	const toggleTheme = () => {
		setTheme((prev) => (prev === "dark" ? "light" : "dark"));
	};

	// API URL for backend - use env var or default to production
	const apiUrl = import.meta.env.VITE_API_URL || "https://chalk-api.q9labs.ai";
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
				: undefined,
		[apiKey, apiUrl],
	);

	const content = (
		<div className={` overflow-hidden bg-background text-foreground ${theme}`}>
			<div className="fixed top-4 right-4 z-50">
				<button
					type="button"
					onClick={toggleTheme}
					className="p-2 rounded-full bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-colors"
					aria-label="Toggle theme"
				>
					{theme === "dark" ? <Sun size={20} /> : <Moon size={20} />}
				</button>
			</div>
			<Outlet />
		</div>
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
		>
			{content}
		</ChalkProvider>
	);
}
