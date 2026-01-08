import { ChalkProvider } from "@q9labs/chalk-react";
import { TanStackDevtools } from "@tanstack/react-devtools";
import {
	createRootRoute,
	HeadContent,
	Outlet,
	Scripts,
} from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

import "../../../../packages/sdk-react/src/styles/base.css";
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
				{import.meta.env.DEV && (
					<script
						src="//unpkg.com/react-grab/dist/index.global.js"
						crossOrigin="anonymous"
					/>
				)}
			</head>
			<body>
				{children}
				{import.meta.env.DEV && (
					<TanStackDevtools
						config={{
							position: "bottom-right",
						}}
						plugins={[
							{
								name: "Tanstack Router",
								render: <TanStackRouterDevtoolsPanel />,
							},
						]}
					/>
				)}
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
	const wsUrl =
		import.meta.env.VITE_WS_URL ||
		(apiUrl
			? (() => {
					const api = new URL(apiUrl);
					const wsProtocol = api.protocol === "https:" ? "wss:" : "ws:";
					return `${wsProtocol}//${api.host}/ws`;
				})()
			: undefined);

	// Token provider for auto-refresh when access token expires
	// Returns empty string if no refresh token (signals SDK to use normal auth)
	const tokenProvider = async (): Promise<string> => {
		const refreshToken = sessionStorage.getItem("chalk_refresh_token");
		if (!refreshToken) {
			// No refresh token yet - this is normal for first join
			// Return empty to signal SDK should proceed with normal authentication
			return "";
		}

		const response = await fetch(`${apiUrl}/api/v1/auth/refresh`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${refreshToken}`,
			},
		});

		if (!response.ok) {
			sessionStorage.removeItem("chalk_refresh_token");
			sessionStorage.removeItem("chalk_access_token");
			throw new Error("Token refresh failed");
		}

		const data = await response.json();
		const newAccessToken = data.accessToken || data.access_token;

		// Update stored tokens
		if (newAccessToken) {
			sessionStorage.setItem("chalk_access_token", newAccessToken);
		}
		if (data.refreshToken || data.refresh_token) {
			sessionStorage.setItem("chalk_refresh_token", data.refreshToken || data.refresh_token);
		}

		return newAccessToken;
	};

	return (
		<ChalkProvider debug={true} apiUrl={apiUrl} wsUrl={wsUrl} tokenProvider={tokenProvider}>
			<div
				className={` overflow-hidden bg-background text-foreground ${theme}`}
			>
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
		</ChalkProvider>
	);
}
