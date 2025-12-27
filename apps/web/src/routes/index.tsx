import {
	Button,
	Card,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@chalk/ui";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
	ArrowRight,
	CheckCircle2,
	Code2,
	Github,
	Globe2,
	Video,
	Zap,
} from "lucide-react";

export const Route = createFileRoute("/")({ component: App });

function App() {
	return (
		<div className="flex min-h-screen flex-col bg-background">
			{/* Navigation */}
			<header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
				<div className="container mx-auto flex h-14 items-center justify-between px-4 sm:px-8">
					<div className="flex items-center gap-2 font-bold text-xl">
						<div className="h-8 w-8 rounded-lg bg-primary flex items-center justify-center text-primary-foreground">
							<Video className="h-5 w-5" />
						</div>
						Chalk
					</div>
					<nav className="flex items-center gap-4">
						<a
							href="https://github.com/Q9Labs/chalk"
							target="_blank"
							rel="noreferrer"
							className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
						>
							<Github className="h-5 w-5" />
							<span className="sr-only">GitHub</span>
						</a>
						<Link to="/demo">
							<Button size="sm">Launch Demo</Button>
						</Link>
					</nav>
				</div>
			</header>

			<main className="flex-1">
				{/* Hero Section */}
				<section className="relative overflow-hidden py-24 sm:py-32 lg:pb-40">
					<div className="absolute inset-0 -z-10 bg-[linear-gradient(to_right,#8080800a_1px,transparent_1px),linear-gradient(to_bottom,#8080800a_1px,transparent_1px)] bg-[size:14px_24px] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,#000_70%,transparent_100%)]" />
					<div className="container mx-auto px-4 sm:px-8 text-center">
						<div className="mx-auto max-w-3xl space-y-8">
							<div className="inline-flex items-center rounded-full border px-3 py-1 text-sm text-muted-foreground bg-background/50 backdrop-blur-sm">
								<span className="flex h-2 w-2 rounded-full bg-green-500 mr-2 animate-pulse"></span>
								v1.0 is now live
							</div>

							<h1 className="text-5xl font-bold tracking-tight sm:text-7xl bg-clip-text text-transparent bg-gradient-to-r from-foreground to-foreground/70">
								Video conferencing <br />
								<span className="text-primary">reimagined</span> for devs.
							</h1>

							<p className="text-xl text-muted-foreground max-w-2xl mx-auto leading-relaxed">
								Add ultra low-latency video and audio to your application in
								minutes. Built on Cloudflare's massive global network for
								uncompromised performance.
							</p>

							<div className="flex flex-col sm:flex-row items-center justify-center gap-4 pt-4">
								<Link to="/demo">
									<Button
										size="lg"
										className="h-12 px-8 text-base shadow-lg shadow-primary/20"
									>
										Try the Demo <ArrowRight className="ml-2 h-4 w-4" />
									</Button>
								</Link>
								<Button
									variant="outline"
									size="lg"
									className="h-12 px-8 text-base"
								>
									Read Documentation
								</Button>
							</div>

							<div className="pt-8 flex items-center justify-center gap-8 text-muted-foreground/50">
								<div className="flex items-center gap-2">
									<CheckCircle2 className="h-4 w-4 text-green-500" />
									<span className="text-sm font-medium text-muted-foreground">
										99.99% Uptime
									</span>
								</div>
								<div className="flex items-center gap-2">
									<CheckCircle2 className="h-4 w-4 text-green-500" />
									<span className="text-sm font-medium text-muted-foreground">
										&lt; 100ms Latency
									</span>
								</div>
								<div className="flex items-center gap-2">
									<CheckCircle2 className="h-4 w-4 text-green-500" />
									<span className="text-sm font-medium text-muted-foreground">
										Global Edge
									</span>
								</div>
							</div>
						</div>
					</div>
				</section>

				{/* Features Grid */}
				<section className="py-24 bg-muted/30 border-y">
					<div className="container mx-auto px-4 sm:px-8">
						<div className="grid gap-8 md:grid-cols-3">
							<Card className="bg-background/60 backdrop-blur-sm border-muted/50">
								<CardHeader>
									<div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-lg bg-blue-500/10 text-blue-500">
										<Zap className="h-6 w-6" />
									</div>
									<CardTitle className="text-xl">Ultra Low Latency</CardTitle>
									<CardDescription className="text-base mt-2">
										Powered by WebRTC and Cloudflare's edge network, ensuring
										your calls are crisp and real-time, no matter where your
										users are.
									</CardDescription>
								</CardHeader>
							</Card>

							<Card className="bg-background/60 backdrop-blur-sm border-muted/50">
								<CardHeader>
									<div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-lg bg-purple-500/10 text-purple-500">
										<Code2 className="h-6 w-6" />
									</div>
									<CardTitle className="text-xl">Developer First</CardTitle>
									<CardDescription className="text-base mt-2">
										Simple, typed SDKs for React, React Native, and Node.js.
										Drop in our pre-built components or build your own UI from
										scratch.
									</CardDescription>
								</CardHeader>
							</Card>

							<Card className="bg-background/60 backdrop-blur-sm border-muted/50">
								<CardHeader>
									<div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-lg bg-orange-500/10 text-orange-500">
										<Globe2 className="h-6 w-6" />
									</div>
									<CardTitle className="text-xl">Global Scale</CardTitle>
									<CardDescription className="text-base mt-2">
										Automatically routes traffic to the nearest edge location.
										Scale from 1-on-1 calls to massive town halls without
										breaking a sweat.
									</CardDescription>
								</CardHeader>
							</Card>
						</div>
					</div>
				</section>

				{/* Code Snippet Section */}
				<section className="py-24">
					<div className="container mx-auto px-4 sm:px-8">
						<div className="grid gap-12 lg:grid-cols-2 items-center">
							<div className="space-y-6">
								<h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
									Ready to drop in?
								</h2>
								<p className="text-lg text-muted-foreground">
									Get started with just a few lines of code. Our React hooks
									make state management a breeze.
								</p>
								<div className="space-y-4">
									<div className="flex items-center gap-4">
										<div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-sm">
											1
										</div>
										<p className="font-medium">Install the package</p>
									</div>
									<div className="flex items-center gap-4">
										<div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-sm">
											2
										</div>
										<p className="font-medium">
											Wrap your app in ChalkProvider
										</p>
									</div>
									<div className="flex items-center gap-4">
										<div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-sm">
											3
										</div>
										<p className="font-medium">Use the useChalk hook</p>
									</div>
								</div>
							</div>

							<div className="relative rounded-xl bg-zinc-950 p-6 shadow-2xl ring-1 ring-white/10">
								<div className="flex items-center gap-2 mb-4 border-b border-white/10 pb-4">
									<div className="h-3 w-3 rounded-full bg-red-500/20 ring-1 ring-red-500/50" />
									<div className="h-3 w-3 rounded-full bg-yellow-500/20 ring-1 ring-yellow-500/50" />
									<div className="h-3 w-3 rounded-full bg-green-500/20 ring-1 ring-green-500/50" />
								</div>
								<pre className="overflow-x-auto text-sm text-zinc-300 font-mono leading-relaxed">
									<code>{`import { useChalk } from '@chalk/react';

function VideoRoom() {
  const { joinRoom, isConnected } = useChalk();

  useEffect(() => {
    joinRoom('daily-standup', {
      video: true,
      audio: true
    });
  }, []);

  if (!isConnected) return <div>Connecting...</div>;

  return <VideoGrid />;
}`}</code>
								</pre>
							</div>
						</div>
					</div>
				</section>
			</main>

			<footer className="border-t py-12 bg-muted/10">
				<div className="container mx-auto px-4 sm:px-8 flex flex-col md:flex-row justify-between items-center gap-6">
					<div className="flex items-center gap-2 font-bold text-lg text-muted-foreground">
						<div className="h-6 w-6 rounded bg-muted-foreground/20 flex items-center justify-center">
							<Video className="h-3 w-3" />
						</div>
						Chalk
					</div>
					<p className="text-sm text-muted-foreground">
						© {new Date().getFullYear()} Chalk. All rights reserved.
					</p>
				</div>
			</footer>
		</div>
	);
}
