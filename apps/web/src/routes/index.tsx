import { Moon02Icon, Sun01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button, Input } from "@q9labs/chalk-ui";
import { createFileRoute } from "@tanstack/react-router";
import {
	ArrowRight,
	Globe,
	Lock,
	MonitorPlay,
	MousePointerClick,
  Video,
  ChevronRight,
} from "lucide-react";
import { useState } from "react";
import { useTheme } from "../context/theme";
import { ChalkLogo } from "../components/ChalkLogo";
import { EdgeNetworkIllustration } from "../components/EdgeNetworkIllustration";

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
		<div className="flex min-h-screen flex-col bg-background selection:bg-primary/20 overflow-x-hidden">
      {/* Premium Background Atmosphere */}
      <div className="fixed inset-0 pointer-events-none -z-10">
        <div className="absolute top-[-20%] left-[-10%] w-[60%] h-[60%] bg-primary/10 rounded-full blur-[140px]" />
        <div className="absolute bottom-[-20%] right-[-10%] w-[60%] h-[60%] bg-blue-500/5 rounded-full blur-[140px]" />
      </div>

			{/* Soft Floating Header */}
			<header className="sticky top-0 z-50 w-full flex justify-center py-6 pointer-events-none">
				<div className="container mx-auto px-6 max-w-6xl pointer-events-auto">
          <div className="glass-panel px-8 h-16 rounded-full flex items-center justify-between">
            <ChalkLogo className="text-foreground" />
            <nav className="hidden md:flex items-center gap-10">
              <a href="/docs" className="text-[11px] font-black uppercase tracking-widest text-muted-foreground hover:text-primary transition-colors">Docs</a>
              <a href="/dashboard" className="text-[11px] font-black uppercase tracking-widest text-muted-foreground hover:text-primary transition-colors">Dashboard</a>
            </nav>
            <div className="flex items-center gap-4">
              <button
                type="button"
                onClick={toggleTheme}
                className="p-2 text-muted-foreground hover:text-foreground transition-colors"
              >
                <HugeiconsIcon icon={theme === "dark" ? Sun01Icon : Moon02Icon} size={18} />
              </button>
              <Button size="sm" onClick={handleStartMeeting} className="premium-button font-bold px-6 shadow-primary/20">
                Join Now
              </Button>
            </div>
          </div>
				</div>
			</header>

			<main className="flex-1">
				{/* Section 1: The Cinematic Hero */}
				<section className="relative pt-20 pb-32 lg:pt-32 lg:pb-48 text-center overflow-visible">
          {/* Background Illustration */}
          <div className="absolute inset-0 z-0 opacity-60 dark:opacity-40">
            <EdgeNetworkIllustration />
          </div>

					<div className="container relative z-10 mx-auto px-6 max-w-5xl space-y-12">
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-secondary/80 border border-border/50 text-[10px] font-black uppercase tracking-widest text-muted-foreground animate-in fade-in slide-in-from-bottom-2 duration-1000">
              <span className="flex h-2 w-2 rounded-full bg-primary animate-pulse" />
              Edge Network Status: Optimal
            </div>

            <h1 className="text-6xl sm:text-8xl lg:text-[7.5rem] font-black tracking-tight leading-[0.9] text-foreground animate-in fade-in slide-in-from-bottom-4 duration-1000 delay-100">
              Video calls, <br />
              <span className="text-primary italic">refined.</span>
            </h1>

            <p className="text-xl lg:text-2xl text-muted-foreground max-w-2xl mx-auto font-medium leading-relaxed animate-in fade-in slide-in-from-bottom-6 duration-1000 delay-200">
              Experience the clarity of zero-latency communication. Built on the edge, designed for the future. No accounts, just connection.
            </p>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-6 pt-10 animate-in fade-in slide-in-from-bottom-8 duration-1000 delay-300">
              <Button size="lg" className="h-16 px-12 rounded-full text-lg font-black shadow-2xl shadow-primary/30 premium-button group" onClick={handleStartMeeting}>
                Start Meeting
                <ChevronRight className="ml-2 h-5 w-5 group-hover:translate-x-1 transition-transform" />
              </Button>
              <div className="relative group">
                <Input
                  placeholder="Meeting Code..."
                  value={meetingCode}
                  onChange={(e) => setMeetingCode(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleJoin()}
                  className="h-16 w-64 bg-secondary/50 border-border/50 rounded-full pl-8 pr-14 focus:ring-8 focus:ring-primary/5 transition-all text-lg font-bold"
                />
                <button onClick={handleJoin} className="absolute right-3 top-1/2 -translate-y-1/2 p-2.5 rounded-full bg-primary text-white hover:scale-110 transition-all shadow-lg">
                  <ArrowRight className="h-5 w-5" />
                </button>
              </div>
            </div>
					</div>
				</section>

				{/* Section 2: Fluid Features */}
				<section className="py-32 bg-secondary/30 relative border-y border-border/50">
					<div className="container mx-auto px-6 max-w-6xl">
						<div className="grid lg:grid-cols-3 gap-10">
							{[
								{
									icon: <MonitorPlay className="h-8 w-8" />,
									title: "Edge Delivery",
									desc: "High-fidelity audio and video routed through Cloudflare's global network."
								},
								{
									icon: <MousePointerClick className="h-8 w-8" />,
									title: "Pure Frictionless",
									desc: "No downloads or signups. Send a link and start collaborating instantly."
								},
								{
									icon: <Lock className="h-8 w-8" />,
									title: "Private & Ephemeral",
									desc: "End-to-end encrypted. We never store your media or session data. Ever."
								}
							].map((f, i) => (
								<div key={i} className="bg-card p-12 rounded-[2.5rem] shadow-soft hover:shadow-heavy transition-all duration-500 group">
									<div className="h-16 w-16 rounded-2xl bg-primary/10 text-primary flex items-center justify-center mb-8 group-hover:scale-110 group-hover:rotate-6 transition-transform">
										{f.icon}
									</div>
									<h3 className="text-2xl font-black tracking-tight mb-4">{f.title}</h3>
									<p className="text-lg text-muted-foreground font-medium leading-relaxed">{f.desc}</p>
								</div>
							))}
						</div>
					</div>
				</section>

				{/* Section 3: Final Call */}
				<section className="py-40 text-center relative overflow-hidden bg-background">
					<div className="container mx-auto px-6 max-w-4xl space-y-12">
						<h2 className="text-5xl sm:text-7xl font-black tracking-tight leading-none text-foreground">
							Ready to connect?
						</h2>
            <p className="text-xl text-muted-foreground font-medium">Join thousands of teams meeting on the edge.</p>
						<Button size="lg" className="h-20 px-16 rounded-full text-xl font-black shadow-2xl shadow-primary/30 premium-button" onClick={handleStartMeeting}>
							Launch Your Room
						</Button>
            <div className="flex flex-wrap justify-center gap-12 pt-16 text-[11px] font-black uppercase tracking-[0.2em] text-muted-foreground/50">
              <span className="flex items-center gap-2"><Globe className="h-4 w-4" /> 250+ Cities</span>
              <span className="flex items-center gap-2"><Lock className="h-4 w-4" /> Secure E2EE</span>
              <span className="flex items-center gap-2"><Video className="h-4 w-4" /> HD 4K Ready</span>
            </div>
					</div>
				</section>
			</main>

			<footer className="py-20 px-12 border-t border-border/50">
				<div className="container mx-auto max-w-6xl flex flex-col md:flex-row justify-between items-center gap-12">
					<ChalkLogo className="text-foreground/50" />
					<nav className="flex gap-12 text-[11px] font-black uppercase tracking-widest text-muted-foreground">
						<a href="/docs" className="hover:text-primary transition-colors">Documentation</a>
						<a href="/privacy" className="hover:text-primary transition-colors">Privacy</a>
						<a href="/terms" className="hover:text-primary transition-colors">Terms</a>
					</nav>
					<p className="text-[11px] font-black uppercase tracking-widest text-muted-foreground/30">
						© {new Date().getFullYear()} Chalk Edge Network
					</p>
				</div>
			</footer>
		</div>
	);
}
