import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, BookOpen, Code2, Key, Zap } from "lucide-react";

import { DocsLayout } from "@/features/docs/components";

export const Route = createFileRoute("/docs/")({ component: DocsIndex });

function DocsIndex() {
	return (
		<DocsLayout>
			<div className="space-y-8">
				<div>
					<h1 className="text-4xl font-bold text-foreground">
						Chalk Documentation
					</h1>
					<p className="mt-4 text-lg text-muted-foreground leading-relaxed">
						Everything you need to integrate Chalk video conferencing into your
						application. From quick start guides to detailed API references.
					</p>
				</div>

				<div className="grid gap-4 md:grid-cols-2">
					<QuickLink
						to="/docs/getting-started"
						icon={<Zap size={24} />}
						title="Getting Started"
						description="Get Chalk running in your Next.js app in under 30 minutes"
						color="blue"
					/>
					<QuickLink
						to="/docs/authentication"
						icon={<Key size={24} />}
						title="Authentication"
						description="Understand the 3-token auth system and secure your integration"
						color="amber"
					/>
					<QuickLink
						to="/docs/sdk-react"
						icon={<Code2 size={24} />}
						title="SDK React"
						description="Explore hooks, components, and the provider pattern"
						color="purple"
					/>
					<QuickLink
						to="/docs/api-reference"
						icon={<BookOpen size={24} />}
						title="API Reference"
						description="Full REST API documentation with request/response examples"
						color="green"
					/>
				</div>

				<div className="border border-border rounded-lg p-6 bg-muted/30">
					<h2 className="text-xl font-semibold text-foreground mb-4">
						Quick Install
					</h2>
					<div className="bg-background rounded-md p-4 font-mono text-sm border border-border">
						npm install @q9labs/chalk-react
					</div>
					<p className="mt-4 text-muted-foreground">
						Then follow the{" "}
						<Link
							to="/docs/getting-started"
							className="text-primary hover:underline font-medium"
						>
							Getting Started guide
						</Link>{" "}
						to set up your backend and frontend.
					</p>
				</div>

				<div className="border border-border rounded-lg p-6">
					<h2 className="text-xl font-semibold text-foreground mb-4">
						Architecture Overview
					</h2>
					<pre className="text-sm text-muted-foreground font-mono bg-muted p-4 rounded-lg overflow-x-auto">
						{`┌─────────────────────────────────────────────────────────────┐
│                 YOUR BACKEND (pages/api/)                   │
│                                                              │
│  1. Store API key in env (never expose to client)           │
│  2. POST /api/v1/auth/token → Get JWT                       │
│  3. POST /api/v1/rooms → Create room                        │
│  4. POST /api/v1/rooms/:id/participants → Get tokens        │
│                                                              │
│  Return to client: { roomId, authToken, accessToken }       │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                YOUR FRONTEND (pages/room/[id].tsx)          │
│                                                              │
│  ChalkProvider receives tokenProvider callback              │
│  SDK uses authToken for WebRTC, accessToken for API         │
│  Token refresh handled automatically                         │
└─────────────────────────────────────────────────────────────┘`}
					</pre>
				</div>
			</div>
		</DocsLayout>
	);
}

interface QuickLinkProps {
	to: string;
	icon: React.ReactNode;
	title: string;
	description: string;
	color: "blue" | "amber" | "purple" | "green";
}

const colorClasses = {
	blue: "bg-blue-500/10 text-blue-500 group-hover:bg-blue-500/20",
	amber: "bg-amber-500/10 text-amber-500 group-hover:bg-amber-500/20",
	purple: "bg-purple-500/10 text-purple-500 group-hover:bg-purple-500/20",
	green: "bg-green-500/10 text-green-500 group-hover:bg-green-500/20",
};

function QuickLink({ to, icon, title, description, color }: QuickLinkProps) {
	return (
		<Link
			to={to}
			className="group flex items-start gap-4 p-4 rounded-lg border border-border bg-card hover:bg-accent transition-colors"
		>
			<div
				className={`shrink-0 p-3 rounded-lg transition-colors ${colorClasses[color]}`}
			>
				{icon}
			</div>
			<div className="min-w-0 flex-1">
				<h3 className="font-semibold text-foreground group-hover:text-primary transition-colors flex items-center gap-2">
					{title}
					<ArrowRight
						size={16}
						className="opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-all"
					/>
				</h3>
				<p className="mt-1 text-sm text-muted-foreground">{description}</p>
			</div>
		</Link>
	);
}
