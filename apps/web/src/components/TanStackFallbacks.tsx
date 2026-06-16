import { HomeIcon, ArrowLeftIcon, AlertCircleIcon, RefreshCcw } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { Button } from "@q9labs/chalk-ui";
import { ChalkLogo } from "./ChalkLogo";
import { useTheme } from "../context/theme";
import { Moon02Icon, Sun01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { ChalkLoader } from "./ChalkLoader";
import { memo } from "react";
import { DOCS_BASE_URL } from "../lib/docsRedirect";

/**
 * Default fallback component shown while TanStack Router is loading routes or data.
 */
export const PendingComponent = memo(() => {
  return (
    <div className="absolute inset-0 z-[100] bg-background flex flex-col items-center justify-center min-h-screen w-full p-8 animate-out fade-out duration-500 fill-mode-forwards pointer-events-none">
      <ChalkLoader size={80} />
    </div>
  );
});

/**
 * Default error fallback shown when a route or loader fails.
 */
export const ErrorComponent = memo(({ error, reset }: { error: Error; reset?: () => void }) => {
  return (
    <div className="flex flex-col items-center justify-center min-h-[80vh] w-full p-8 animate-in fade-in duration-300">
      <div className="w-16 h-16 rounded-2xl bg-destructive/10 border border-destructive/20 flex items-center justify-center mb-8">
        <AlertCircleIcon className="w-8 h-8 text-destructive" />
      </div>

      <div className="text-center space-y-6 max-w-md">
        <div className="space-y-2">
          <h2 className="font-app font-bold text-2xl tracking-tight text-foreground">Something went wrong</h2>
          <p className="text-sm text-muted-foreground leading-relaxed balance-text">An unexpected error occurred. Please try refreshing the page or going back.</p>
        </div>

        {error.message && (
          <div className="p-4 rounded-xl bg-secondary/50 border border-border text-left overflow-hidden">
            <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-1">Error Trace</p>
            <p className="text-xs font-mono text-muted-foreground break-all leading-normal">{error.message}</p>
          </div>
        )}

        <div className="flex flex-col sm:flex-row items-center justify-center gap-4 pt-8">
          {reset ? (
            <Button size="lg" onClick={reset} className="w-full sm:w-auto px-10 h-12 font-medium">
              <RefreshCcw className="w-4 h-4 mr-2" />
              Try Again
            </Button>
          ) : (
            <Button size="lg" onClick={() => window.location.reload()} className="w-full sm:w-auto px-10 h-12 font-medium">
              <RefreshCcw className="w-4 h-4 mr-2" />
              Refresh Page
            </Button>
          )}
          <Button size="lg" variant="secondary" onClick={() => window.history.back()} className="w-full sm:w-auto px-10 h-12 font-medium">
            Go Back
          </Button>
        </div>
      </div>
    </div>
  );
});

/**
 * Default 404 fallback shown when a route is not found.
 * Designed as a full-page experience consistent with the new UI.
 */
export const NotFoundComponent = memo(() => {
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="font-app flex h-screen flex-col bg-background text-foreground selection:bg-primary/20 overflow-hidden relative">
      {/* Background Atmosphere */}
      <div className="fixed inset-0 pointer-events-none -z-10">
        <div className="absolute top-[10%] left-[5%] w-[60vw] h-[60vw] bg-primary/5 rounded-full blur-[140px] opacity-60" />
        <div className="absolute bottom-[10%] right-[5%] w-[50vw] h-[50vw] bg-blue-500/5 rounded-full blur-[140px] opacity-40" />
      </div>

      {/* Header */}
      <header className="shrink-0 w-full border-b border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between max-w-7xl">
          <Link to="/">
            <ChalkLogo />
          </Link>
          <div className="flex items-center gap-6">
            <nav className="hidden md:flex items-center gap-6 text-sm font-medium">
              <Link to="/dashboard" className="text-muted-foreground hover:text-foreground transition-colors">
                Dashboard
              </Link>
              <a href={DOCS_BASE_URL} className="text-muted-foreground hover:text-foreground transition-colors">
                Documentation
              </a>
            </nav>
            <button type="button" onClick={toggleTheme} className="p-2 text-muted-foreground hover:text-foreground rounded-full hover:bg-secondary transition-colors" aria-label="Toggle theme">
              <HugeiconsIcon icon={theme === "dark" ? Sun01Icon : Moon02Icon} size={18} />
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center p-4 relative z-10">
        <div className="max-w-3xl w-full text-center space-y-12 animate-in fade-in slide-in-from-bottom-4 duration-500">
          <div className="relative inline-flex items-center justify-center mb-4">
            <div className="relative z-10 flex items-center justify-center">
              <ChalkLoader size={140} />
            </div>
            <div className="absolute inset-0 bg-primary/20 blur-[50px] rounded-full scale-150 opacity-40 animate-pulse" />
          </div>

          <div className="space-y-4">
            <h1 className="text-5xl md:text-7xl font-bold tracking-tight text-foreground balance-text leading-[1.1]">Lost in space.</h1>
            <p className="text-xl text-muted-foreground max-w-xl mx-auto balance-text">The page you're looking for doesn't exist or has been moved to a different coordinate.</p>
          </div>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 pt-4">
            <Link to="/" className="w-full sm:w-auto">
              <Button size="lg" className="w-full px-10 h-12 font-medium shadow-lg shadow-primary/10">
                <HomeIcon className="w-4 h-4 mr-2" />
                Return Home
              </Button>
            </Link>
            <Button size="lg" variant="secondary" onClick={() => window.history.back()} className="w-full sm:w-auto px-10 h-12 font-medium">
              <ArrowLeftIcon className="w-4 h-4 mr-2" />
              Go Back
            </Button>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="shrink-0 py-8 border-t border-border/40">
        <div className="container mx-auto px-4 max-w-7xl flex flex-col md:flex-row justify-between items-center gap-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <ChalkLogo className="h-5 w-auto grayscale opacity-50" />
            <span>© {new Date().getFullYear()} Chalk</span>
          </div>
          <nav className="flex gap-8 text-sm text-muted-foreground">
            <Link to="/dashboard" className="hover:text-foreground transition-colors">
              Dashboard
            </Link>
            <a href={DOCS_BASE_URL} className="hover:text-foreground transition-colors">
              Documentation
            </a>
            <a href="/privacy" className="hover:text-foreground transition-colors">
              Privacy
            </a>
            <a href="/terms" className="hover:text-foreground transition-colors">
              Terms
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
});
