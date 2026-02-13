import { Moon02Icon, Sun01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge, Button, Card, CardDescription, CardHeader, CardTitle, Input } from "@q9labs/chalk-ui";
import { createFileRoute } from "@tanstack/react-router";
import {
	ArrowRight,
	Briefcase,
	Globe,
	GraduationCap,
	Heart,
	Laptop2,
	Lock,
	MonitorPlay,
	MousePointerClick,
	ShieldCheck,
	Sparkles,
	Video,
} from "lucide-react";
import { useState } from "react";
import { useTheme } from "../context/theme";

function ChalkLogo({ className }: { className?: string }) {
	return (
		<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 280 80" fill="none" className={className}>
			<g>
				<g transform="rotate(-15 20 60)">
					<rect x="8" y="20" width="14" height="50" rx="7" fill="#A8D5A2"/>
					<ellipse cx="15" cy="20" rx="7" ry="4" fill="#8BC585"/>
				</g>
				<g transform="rotate(-8 32 55)">
					<rect x="22" y="15" width="14" height="52" rx="7" fill="#F5D76E"/>
					<ellipse cx="29" cy="15" rx="7" ry="4" fill="#E8C85A"/>
				</g>
				<g transform="rotate(12 60 30)">
					<rect x="35" y="8" width="14" height="55" rx="7" fill="#7EC8E3"/>
					<ellipse cx="42" cy="8" rx="7" ry="4" fill="#5FB8D9"/>
				</g>
				<g transform="rotate(5 55 50)">
					<rect x="48" y="22" width="14" height="48" rx="7" fill="#F0A0A0"/>
					<ellipse cx="55" cy="70" rx="7" ry="4" fill="#E88888"/>
				</g>
			</g>
			<text x="90" y="52" fontFamily="system-ui, -apple-system, BlinkMacSystemFont, sans-serif" fontSize="38" fontWeight="600" letterSpacing="-0.02em" fill="currentColor">chalk</text>
		</svg>
	);
}

export const Route = createFileRoute("/")({ component: App });

function generateRoomId() {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
	let result = "room-";
	for (let i = 0; i < 8; i++) {
		result += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return result;
}

function App() {
	const [meetingCode, setMeetingCode] = useState("");
	const { theme, toggleTheme } = useTheme();

	const handleStartMeeting = () => {
		const roomId = generateRoomId();
		window.open(`/room/${roomId}`, "_blank", "noopener,noreferrer");
	};

	const handleJoin = () => {
		if (!meetingCode.trim()) return;
		const roomId = meetingCode.includes("/room/")
			? (meetingCode.split("/room/")[1]?.split("?")[0] ?? meetingCode.trim())
			: meetingCode.trim();
		window.open(`/room/${roomId}`, "_blank", "noopener,noreferrer");
	};

	return (
		<div className="flex min-h-screen flex-col bg-background">
			{/* Header */}
			<header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
				<div className="container mx-auto flex h-14 items-center justify-between px-4 sm:px-8">
					<ChalkLogo className="h-8 w-auto" />
					<nav className="flex items-center gap-2 sm:gap-4">
						<a
							href="/docs"
							className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors hidden sm:block"
						>
							Docs
						</a>
						<a
							href="/dashboard"
							className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors hidden sm:block"
						>
							Dashboard
						</a>
						<button
							type="button"
							onClick={toggleTheme}
							className="p-2 rounded-full text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
							aria-label="Toggle theme"
						>
							<HugeiconsIcon
								icon={theme === "dark" ? Sun01Icon : Moon02Icon}
								size={18}
							/>
						</button>
						<Button size="sm" onClick={handleStartMeeting}>
							<Video className="h-4 w-4 mr-2" />
							Start Meeting
						</Button>
					</nav>
				</div>
			</header>

			<main className="flex-1">
				{/* Hero Section */}
				<section className="relative overflow-hidden py-16 sm:py-24 lg:py-32">
					{/* Diagonal cross grid pattern - light mode only */}
					<div
						className="absolute inset-0 pointer-events-none dark:hidden"
						style={{
							backgroundImage: `
								linear-gradient(45deg, transparent 49%, #d1d5db 49%, #d1d5db 51%, transparent 51%),
								linear-gradient(-45deg, transparent 49%, #d1d5db 49%, #d1d5db 51%, transparent 51%)
							`,
							backgroundSize: "40px 40px",
							WebkitMaskImage: "radial-gradient(ellipse 80% 80% at 100% 100%, #000 50%, transparent 90%)",
							maskImage: "radial-gradient(ellipse 80% 80% at 100% 100%, #000 50%, transparent 90%)",
						}}
					/>

					<div className="container mx-auto px-4 sm:px-8">
						<div className="grid gap-12 lg:grid-cols-2 lg:gap-16 items-center">
							{/* Left: Content */}
							<div className="space-y-8">
								<Badge variant="secondary" className="inline-flex items-center gap-2 px-3 py-1">
									<span className="flex h-2 w-2 rounded-full bg-green-500 animate-pulse" />
									No signup to join &bull; Optional host dashboard
								</Badge>

								<h1 className="text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl">
									Connect instantly.
									<br />
									<span className="text-primary">Meet effortlessly.</span>
								</h1>

								<p className="text-lg text-muted-foreground max-w-lg">
									HD video meetings that just work. No downloads, no accounts, no hassle.
								</p>

								<div className="flex flex-wrap items-center gap-3">
									<Button size="lg" className="h-12 px-8 text-base shadow-lg shadow-primary/20" onClick={handleStartMeeting}>
										<Video className="h-5 w-5 mr-2" />
										Start a Meeting
									</Button>
									<span className="text-muted-foreground">or</span>
									<Input
										placeholder="Enter meeting code"
										value={meetingCode}
										onChange={(e) => setMeetingCode(e.target.value)}
										onKeyDown={(e) => e.key === "Enter" && handleJoin()}
										className="w-48"
									/>
								</div>
							</div>

							{/* Right: Illustration */}
							<div className="relative lg:pl-8">
								<img
									src="/devices-with-video.png"
									alt="Video conferencing on multiple devices"
									className="w-full max-w-lg mx-auto drop-shadow-2xl"
								/>
							</div>
						</div>
					</div>
				</section>

				{/* Trust Bar */}
				<section className="py-8 border-y bg-muted/30">
					<div className="container mx-auto px-4 sm:px-8">
						<div className="grid grid-cols-2 md:grid-cols-4 gap-6 text-center">
							<div className="flex flex-col items-center gap-2">
								<ShieldCheck className="h-6 w-6 text-primary" />
								<span className="text-sm font-medium">End-to-end encrypted</span>
							</div>
							<div className="flex flex-col items-center gap-2">
								<MonitorPlay className="h-6 w-6 text-primary" />
								<span className="text-sm font-medium">HD Video & Audio</span>
							</div>
							<div className="flex flex-col items-center gap-2">
								<Globe className="h-6 w-6 text-primary" />
								<span className="text-sm font-medium">Works in your browser</span>
							</div>
							<div className="flex flex-col items-center gap-2">
								<Sparkles className="h-6 w-6 text-primary" />
								<span className="text-sm font-medium">100% Free</span>
							</div>
						</div>
					</div>
				</section>

				{/* Features */}
				<section className="py-20 sm:py-24">
					<div className="container mx-auto px-4 sm:px-8">
						<div className="text-center mb-12">
							<h2 className="text-3xl font-bold tracking-tight sm:text-4xl mb-4">
								Everything you need, nothing you don't
							</h2>
							<p className="text-lg text-muted-foreground">
								Video meetings designed for real people.
							</p>
						</div>

						<div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
							<Card className="bg-background/60 backdrop-blur-sm">
								<CardHeader>
									<div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-lg bg-blue-500/10 text-blue-500">
										<MonitorPlay className="h-6 w-6" />
									</div>
									<CardTitle className="text-xl">Crystal Clear Quality</CardTitle>
									<CardDescription className="text-base mt-2">
										HD video and studio-quality audio that makes every conversation feel natural.
									</CardDescription>
								</CardHeader>
							</Card>

							<Card className="bg-background/60 backdrop-blur-sm">
								<CardHeader>
									<div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-lg bg-purple-500/10 text-purple-500">
										<MousePointerClick className="h-6 w-6" />
									</div>
									<CardTitle className="text-xl">One-Click Meetings</CardTitle>
									<CardDescription className="text-base mt-2">
										No signup, no download. Just click and connect instantly with anyone.
									</CardDescription>
								</CardHeader>
							</Card>

							<Card className="bg-background/60 backdrop-blur-sm">
								<CardHeader>
									<div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-lg bg-green-500/10 text-green-500">
										<Lock className="h-6 w-6" />
									</div>
									<CardTitle className="text-xl">Private & Secure</CardTitle>
									<CardDescription className="text-base mt-2">
										Enterprise-grade encryption keeps your conversations private. No data selling.
									</CardDescription>
								</CardHeader>
							</Card>

							<Card className="bg-background/60 backdrop-blur-sm">
								<CardHeader>
									<div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-lg bg-orange-500/10 text-orange-500">
										<Laptop2 className="h-6 w-6" />
									</div>
									<CardTitle className="text-xl">Works Everywhere</CardTitle>
									<CardDescription className="text-base mt-2">
										Desktop, tablet, or phone. Join from any device with a browser.
									</CardDescription>
								</CardHeader>
							</Card>
						</div>
					</div>
				</section>

				{/* How It Works */}
				<section className="py-20 sm:py-24 bg-muted/30 border-y">
					<div className="container mx-auto px-4 sm:px-8">
						<div className="text-center mb-12">
							<h2 className="text-3xl font-bold tracking-tight sm:text-4xl mb-4">
								Start meeting in 3 simple steps
							</h2>
						</div>

						<div className="grid gap-8 md:grid-cols-3 max-w-4xl mx-auto">
							<div className="text-center">
								<div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-primary text-primary-foreground text-2xl font-bold">
									1
								</div>
								<h3 className="text-xl font-semibold mb-2">Click Start</h3>
								<p className="text-muted-foreground">Create your meeting room instantly</p>
							</div>

							<div className="text-center relative">
								<div className="hidden md:block absolute top-8 -left-4 w-8 h-px bg-border" />
								<div className="hidden md:block absolute top-8 -right-4 w-8 h-px bg-border" />
								<div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-primary text-primary-foreground text-2xl font-bold">
									2
								</div>
								<h3 className="text-xl font-semibold mb-2">Share the Link</h3>
								<p className="text-muted-foreground">Copy & send to anyone you want to meet</p>
							</div>

							<div className="text-center">
								<div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-primary text-primary-foreground text-2xl font-bold">
									3
								</div>
								<h3 className="text-xl font-semibold mb-2">Start Talking</h3>
								<p className="text-muted-foreground">Everyone joins instantly, no waiting</p>
							</div>
						</div>
					</div>
				</section>

				{/* Use Cases */}
				<section className="py-20 sm:py-24">
					<div className="container mx-auto px-4 sm:px-8">
						<div className="grid gap-6 md:grid-cols-3 max-w-4xl mx-auto">
							<Card className="text-center">
								<CardHeader>
									<div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-blue-500/10 text-blue-500">
										<Briefcase className="h-7 w-7" />
									</div>
									<CardTitle className="text-xl">Remote Work</CardTitle>
									<CardDescription className="text-base mt-2">
										Team standups, client calls, and seamless collaboration from anywhere.
									</CardDescription>
								</CardHeader>
							</Card>

							<Card className="text-center">
								<CardHeader>
									<div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-purple-500/10 text-purple-500">
										<GraduationCap className="h-7 w-7" />
									</div>
									<CardTitle className="text-xl">Education</CardTitle>
									<CardDescription className="text-base mt-2">
										Tutoring sessions, study groups, and virtual classrooms made simple.
									</CardDescription>
								</CardHeader>
							</Card>

							<Card className="text-center">
								<CardHeader>
									<div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-rose-500/10 text-rose-500">
										<Heart className="h-7 w-7" />
									</div>
									<CardTitle className="text-xl">Stay Connected</CardTitle>
									<CardDescription className="text-base mt-2">
										Family and friends, anywhere in the world. Bridge the distance.
									</CardDescription>
								</CardHeader>
							</Card>
						</div>
					</div>
				</section>

				{/* Final CTA */}
				<section className="py-20 sm:py-24 bg-primary/5 border-t">
					<div className="container mx-auto px-4 sm:px-8 text-center">
						<h2 className="text-3xl font-bold tracking-tight sm:text-4xl mb-4">
							Ready to connect?
						</h2>
						<p className="text-lg text-muted-foreground mb-8 max-w-lg mx-auto">
							Start your free meeting now. No signup, no download, no waiting.
						</p>
						<Button size="lg" className="h-12 px-8 text-base shadow-lg shadow-primary/20" onClick={handleStartMeeting}>
							Start Your Free Meeting
							<ArrowRight className="ml-2 h-5 w-5" />
						</Button>
					</div>
				</section>
			</main>

			{/* Footer */}
			<footer className="border-t py-8 bg-muted/10">
				<div className="container mx-auto px-4 sm:px-8">
					<div className="flex flex-col md:flex-row justify-between items-center gap-6">
						<ChalkLogo className="h-6 w-auto opacity-75" />
						<nav className="flex items-center gap-6 text-sm text-muted-foreground">
							<a href="/docs" className="hover:text-foreground transition-colors">Docs</a>
							<a href="/privacy" className="hover:text-foreground transition-colors">Privacy</a>
							<a href="/terms" className="hover:text-foreground transition-colors">Terms</a>
						</nav>
						<p className="text-sm text-muted-foreground">
							© {new Date().getFullYear()} Chalk
						</p>
					</div>
				</div>
			</footer>
		</div>
	);
}
