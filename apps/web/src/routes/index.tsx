import { Moon02Icon, Sun01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@q9labs/chalk-ui";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { Globe, Lock, MonitorPlay, MousePointerClick } from "lucide-react";
import { useTheme } from "../context/theme";
import { ChalkLogo } from "../components/ChalkLogo";

export const Route = createFileRoute("/")({ component: App });

function App() {
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();

  const handleStartMeeting = () => {
    navigate({ to: "/new" });
  };

  return (
    <div className="font-app flex min-h-screen flex-col bg-background text-foreground relative overflow-x-hidden">
      {/* Header */}
      <header className="sticky top-0 z-50 w-full border-b border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between max-w-7xl">
          <div className="flex items-center gap-6">
            <ChalkLogo />
          </div>

          <div className="flex items-center gap-4">
            <nav className="hidden md:flex items-center gap-6 text-sm font-medium">
              <Link to="/documentation" className="text-muted-foreground hover:text-foreground transition-colors">
                Documentation
              </Link>
              <Link to="/dashboard" className="text-muted-foreground hover:text-foreground transition-colors">
                Dashboard
              </Link>
            </nav>
            <div className="flex items-center gap-2">
              <button type="button" onClick={toggleTheme} className="p-2 text-muted-foreground hover:text-foreground rounded-full hover:bg-secondary transition-colors" aria-label="Toggle theme">
                <HugeiconsIcon icon={theme === "dark" ? Sun01Icon : Moon02Icon} size={18} />
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 w-full flex flex-col relative">
        {/* Hero Section with contained background */}
        <section className="relative w-full overflow-hidden border-b border-border/40">
          {/* Background Image - Clean integration with theme-specific logic */}
          <div className="absolute inset-0 z-0 pointer-events-none flex items-center justify-center">
            <div className="relative w-full h-full max-w-[1400px] flex items-center justify-center overflow-hidden p-4 sm:p-0">
              {/* Dark/Nord Image - Vivid and impactful */}
              <img
                src="/hero-1.png"
                alt=""
                className="hidden dark:block w-full h-auto object-contain sm:object-cover opacity-60 scale-90 transition-all duration-500"
                style={{
                  maskImage: "radial-gradient(circle at center, black 20%, transparent 80%)",
                  WebkitMaskImage: "radial-gradient(circle at center, black 20%, transparent 80%)",
                }}
              />
              {/* Light Mode Image - Hyper-subtle watermark, no gray haze */}
              <img
                src="/hero-1.png"
                alt=""
                className="block dark:hidden w-full h-auto object-contain sm:object-cover opacity-[0.03] scale-100 filter grayscale transition-all duration-500"
                style={{
                  maskImage: "radial-gradient(circle at center, black 10%, transparent 70%)",
                  WebkitMaskImage: "radial-gradient(circle at center, black 10%, transparent 70%)",
                }}
              />
            </div>
          </div>

          <div className="container relative z-10 mx-auto px-4 max-w-5xl py-24 lg:py-40 flex flex-col items-center">
            <div className="space-y-10 flex flex-col items-center w-full">
              <div className="space-y-6 flex flex-col items-center w-full text-center">
                <h1 className="text-5xl lg:text-7xl font-bold tracking-tighter text-foreground leading-[1.1] max-w-4xl balance-text">Video meetings for modern teams.</h1>

                <p className="text-xl text-foreground/70 dark:text-muted-foreground leading-relaxed max-w-2xl balance-text text-center mx-auto font-medium">High-fidelity audio and video routed through the edge. Experience communication without the friction.</p>
              </div>

              <div className="flex flex-col gap-4 w-full justify-center items-center">
                <Button size="lg" className="h-12 px-8 font-medium shadow-lg shadow-primary/20" onClick={handleStartMeeting}>
                  New Meeting
                </Button>
                <p className="max-w-lg text-center text-sm font-medium text-foreground/65 dark:text-muted-foreground">Joining a meeting? Open your Chalk invite link to jump straight into the right room.</p>
              </div>

              <div className="flex items-center justify-center gap-8 text-sm font-semibold text-foreground/60 dark:text-foreground bg-background/30 backdrop-blur-xl px-6 py-2 rounded-full border border-border/40 shadow-sm">
                <span className="flex items-center gap-2">
                  <Lock className="h-4 w-4 text-primary" /> E2E Encrypted
                </span>
                <span className="flex items-center gap-2">
                  <Globe className="h-4 w-4 text-primary" /> No signup required
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* Features Grid */}
        <section className="bg-secondary/10 relative z-10">
          <div className="container mx-auto px-4 max-w-7xl py-24">
            <div className="grid md:grid-cols-3 gap-8">
              <div className="p-8 bg-background rounded-2xl border border-border/50 shadow-sm transition-all hover:shadow-md hover:-translate-y-1">
                <MonitorPlay className="h-8 w-8 text-primary mb-6" />
                <h3 className="text-xl font-semibold mb-3 text-center md:text-left">Edge Routing</h3>
                <p className="text-muted-foreground leading-relaxed text-center md:text-left">Connections are routed through the closest data center globally, minimizing latency.</p>
              </div>
              <div className="p-8 bg-background rounded-2xl border border-border/50 shadow-sm transition-all hover:shadow-md hover:-translate-y-1">
                <MousePointerClick className="h-8 w-8 text-primary mb-6" />
                <h3 className="text-xl font-semibold mb-3 text-center md:text-left">Zero Friction</h3>
                <p className="text-muted-foreground leading-relaxed text-center md:text-left">No apps to download. Share a link and your participants can join instantly from any browser.</p>
              </div>
              <div className="p-8 bg-background rounded-2xl border border-border/50 shadow-sm transition-all hover:shadow-md hover:-translate-y-1">
                <Lock className="h-8 w-8 text-primary mb-6" />
                <h3 className="text-xl font-semibold mb-3 text-center md:text-left">Absolute Privacy</h3>
                <p className="text-muted-foreground leading-relaxed text-center md:text-left">Sessions are ephemeral and end-to-end encrypted. We never record or store your meetings.</p>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="py-12 border-t border-border/40 bg-background relative z-10">
        <div className="container mx-auto px-4 max-w-7xl flex flex-col md:flex-row justify-between items-center gap-8">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <ChalkLogo className="h-5 w-auto grayscale opacity-50" />
            <span>© {new Date().getFullYear()} Chalk</span>
          </div>
          <nav className="flex gap-8 text-sm text-muted-foreground">
            <Link to="/dashboard" className="hover:text-foreground transition-colors">
              Dashboard
            </Link>
            <a href="/privacy" className="hover:text-foreground transition-colors">
              Privacy
            </a>
            <a href="/terms" className="hover:text-foreground transition-colors">
              Terms
            </a>
            <a href="/documentation" className="md:hidden hover:text-foreground transition-colors">
              Docs
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
