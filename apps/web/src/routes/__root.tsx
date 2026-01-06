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

	// WebSocket URL for real-time features (hand raise, reactions, chat)
	// const wsUrl = import.meta.env.VITE_WS_URL || 'ws://localhost:8080/ws';

	return (
		<ChalkProvider
			debug={true}
			// wsUrl={wsUrl}
		>
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
