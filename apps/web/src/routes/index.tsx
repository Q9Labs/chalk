import { Moon02Icon, Sun01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@q9labs/chalk-ui";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { Globe, Lock, MonitorPlay, MousePointerClick } from "lucide-react";
import { useTheme } from "../context/theme";
import { ChalkLogo } from "../components/ChalkLogo";
import { DOCS_BASE_URL } from "../lib/docsRedirect";

export const Route = createFileRoute("/")({ component: App });

function App() {
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();

  const handleStartMeeting = () => {
    navigate({ to: "/new" });
  };

  return (
    <div className="font-app flex min-h-screen flex-col bg-background text-foreground relative overflow-x-hidden selection:bg-primary/20 selection:text-primary animate-in fade-in duration-700 zoom-in-[0.99]">
      {/* Header */}
      <header className="sticky top-0 z-50 w-full border-b border-border/40 bg-background/80 backdrop-blur-xl supports-[backdrop-filter]:bg-background/60">
        <div className="container mx-auto px-6 h-16 flex items-center justify-between max-w-7xl">
          <div className="flex items-center gap-6">
            <ChalkLogo />
          </div>

          <div className="flex items-center gap-4">
            <nav className="hidden md:flex items-center gap-6 text-sm font-medium tracking-tight">
              <a href={DOCS_BASE_URL} className="text-muted-foreground hover:text-foreground transition-colors">
                Documentation
              </a>
              <Link to="/room/$roomId" params={{ roomId: "abc" }} className="text-muted-foreground hover:text-foreground transition-colors">
                Room
              </Link>
              <Link to="/status" className="text-muted-foreground hover:text-foreground transition-colors">
                Status
              </Link>
            </nav>
            <div className="flex items-center gap-2 pl-2 md:pl-4 md:border-l border-border/50">
              <button type="button" onClick={toggleTheme} className="p-2 text-muted-foreground hover:text-foreground rounded-full hover:bg-secondary transition-colors" aria-label="Toggle theme">
                <HugeiconsIcon icon={theme === "dark" ? Sun01Icon : Moon02Icon} size={18} />
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 w-full flex flex-col relative">
        {/* Hero Section */}
        <section className="relative w-full overflow-hidden border-b border-border/40">
          {/* Background Illustration / Image */}
          <div className="absolute inset-0 z-0 pointer-events-none flex items-start justify-center pt-20">
            <div className="relative w-full max-w-[1200px] flex items-center justify-center opacity-40 dark:opacity-60 transition-opacity duration-700 blur-[2px]">
              <picture className="block w-full">
                <source type="image/webp" srcSet="/images/marketing/hero-1-640.webp 640w, /images/marketing/hero-1-960.webp 960w, /images/marketing/hero-1-1280.webp 1280w, /images/marketing/hero-1-1920.webp 1920w" sizes="(min-width: 1200px) 1200px, 100vw" />
                <img src="/images/marketing/hero-1.png" alt="" width={2560} height={1476} fetchPriority="high" decoding="async" className="w-full h-auto object-cover mask-image-gradient" style={{ WebkitMaskImage: "linear-gradient(to bottom, rgba(0,0,0,1) 20%, rgba(0,0,0,0) 100%)" }} />
              </picture>
            </div>
          </div>

          <div className="container relative z-10 mx-auto px-6 max-w-5xl py-24 lg:py-32 flex flex-col items-center">
            <div className="space-y-10 flex flex-col items-center w-full">
              <div className="space-y-6 flex flex-col items-center w-full text-center">
                <h1 className="text-5xl sm:text-6xl lg:text-7xl font-bold tracking-tight text-foreground leading-[1.05] max-w-4xl text-balance">Video meetings for modern teams.</h1>

                <p className="text-lg sm:text-xl text-muted-foreground leading-relaxed max-w-2xl text-balance text-center mx-auto">High-fidelity audio and video routed through the edge. Experience communication without the friction.</p>
              </div>

              <div className="flex flex-col gap-6 w-full justify-center items-center mt-4">
                <Button size="lg" className="h-12 md:h-14 px-8 md:px-10 text-base font-semibold rounded-full shadow-lg shadow-primary/20 hover:scale-[1.02] active:scale-[0.98] transition-all" onClick={handleStartMeeting}>
                  Start a Meeting
                </Button>
                <p className="max-w-lg text-center text-sm text-muted-foreground">Joining a meeting? Open your Chalk invite link to jump straight into the right room.</p>
              </div>

              <div className="flex flex-wrap justify-center items-center gap-6 md:gap-10 text-sm font-medium text-muted-foreground pt-8">
                <span className="flex items-center gap-2">
                  <Lock className="h-4 w-4" /> E2E Encrypted
                </span>
                <span className="flex items-center gap-2">
                  <Globe className="h-4 w-4" /> No downloads required
                </span>
                <span className="flex items-center gap-2">
                  <MonitorPlay className="h-4 w-4" /> Browser native
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* Features Grid */}
        <section className="bg-secondary/20 relative z-10">
          <div className="container mx-auto px-6 max-w-7xl py-24 md:py-32">
            <div className="text-center mb-16 space-y-4">
              <h2 className="text-3xl md:text-4xl font-bold tracking-tight">Built for speed and privacy.</h2>
            </div>

            <div className="grid md:grid-cols-3 gap-8">
              <div className="p-8 bg-background rounded-[1.5rem] border border-border/50 shadow-sm transition-all hover:shadow-md hover:border-border/80 group">
                <div className="w-12 h-12 bg-secondary rounded-xl flex items-center justify-center mb-6 group-hover:scale-105 transition-transform">
                  <MonitorPlay className="h-6 w-6 text-primary" />
                </div>
                <h3 className="text-xl font-semibold mb-3 tracking-tight">Edge Routing</h3>
                <p className="text-muted-foreground leading-relaxed text-sm md:text-base">Connections are routed through the closest data center globally, physically minimizing latency for all participants.</p>
              </div>
              <div className="p-8 bg-background rounded-[1.5rem] border border-border/50 shadow-sm transition-all hover:shadow-md hover:border-border/80 group">
                <div className="w-12 h-12 bg-secondary rounded-xl flex items-center justify-center mb-6 group-hover:scale-105 transition-transform">
                  <MousePointerClick className="h-6 w-6 text-primary" />
                </div>
                <h3 className="text-xl font-semibold mb-3 tracking-tight">Zero Friction</h3>
                <p className="text-muted-foreground leading-relaxed text-sm md:text-base">No apps to download or accounts to create. Share a link and your participants can join instantly.</p>
              </div>
              <div className="p-8 bg-background rounded-[1.5rem] border border-border/50 shadow-sm transition-all hover:shadow-md hover:border-border/80 group">
                <div className="w-12 h-12 bg-secondary rounded-xl flex items-center justify-center mb-6 group-hover:scale-105 transition-transform">
                  <Lock className="h-6 w-6 text-primary" />
                </div>
                <h3 className="text-xl font-semibold mb-3 tracking-tight">Absolute Privacy</h3>
                <p className="text-muted-foreground leading-relaxed text-sm md:text-base">Sessions are ephemeral and end-to-end encrypted. We never record or store your meetings.</p>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="py-12 border-t border-border/40 bg-background relative z-10">
        <div className="container mx-auto px-6 max-w-7xl flex flex-col md:flex-row justify-between items-center gap-8">
          <div className="flex items-center gap-3 text-sm text-muted-foreground font-medium">
            <ChalkLogo className="h-5 w-auto grayscale opacity-40" />
            <span>© {new Date().getFullYear()} Chalk</span>
          </div>
          <nav className="flex gap-6 md:gap-8 text-sm font-medium text-muted-foreground">
            <Link to="/room/$roomId" params={{ roomId: "abc" }} className="hover:text-foreground transition-colors">
              Room
            </Link>
            <a href="/privacy" className="hover:text-foreground transition-colors">
              Privacy
            </a>
            <a href="/terms" className="hover:text-foreground transition-colors">
              Terms
            </a>
            <a href={DOCS_BASE_URL} className="md:hidden hover:text-foreground transition-colors">
              Docs
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
