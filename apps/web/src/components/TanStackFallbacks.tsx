import { AlertCircleIcon, FileQuestionIcon, HomeIcon, ArrowLeftIcon } from "lucide-react";
import { ChalkLoader } from "./ChalkLoader";
import { Link } from "@tanstack/react-router";

/**
 * Default fallback component shown while TanStack Router is loading routes or data.
 * Designed to feel integrated with the Chalk app theme.
 */
export function PendingComponent() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] w-full p-8 animate-in fade-in duration-700">
      <div className="mb-12">
        <ChalkLoader size={80} />
      </div>
      <div className="text-center space-y-3 max-w-[320px]">
        <h3 className="font-display font-bold text-2xl tracking-tight text-foreground">
          Setting the stage…
        </h3>
        <p className="text-sm text-muted-foreground leading-relaxed">
          One moment while we prepare your chalk room.
        </p>
        <div className="flex items-center justify-center gap-2 pt-4">
          <div className="w-1 h-1 rounded-full bg-primary animate-bounce [animation-delay:-0.3s]" />
          <div className="w-1 h-1 rounded-full bg-primary animate-bounce [animation-delay:-0.15s]" />
          <div className="w-1 h-1 rounded-full bg-primary animate-bounce" />
        </div>
      </div>
    </div>
  );
}

interface ErrorComponentProps {
  error: Error;
  reset?: () => void;
}

/**
 * Default error fallback shown when a route or loader fails.
 * Includes a trace ID if available and a way to retry.
 */
export function ErrorComponent({ error, reset }: ErrorComponentProps) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] w-full p-8 animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div className="w-16 h-16 rounded-2xl bg-destructive/10 border border-destructive/20 flex items-center justify-center mb-6">
        <AlertCircleIcon className="w-8 h-8 text-destructive" />
      </div>

      <div className="text-center space-y-4 max-w-md">
        <div className="space-y-2">
          <h2 className="font-display font-bold text-2xl tracking-tight text-foreground">
            Something went wrong
          </h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            We encountered an error while trying to load this page. This could be due to a network issue or a temporary glitch.
          </p>
        </div>

        {error.message && (
          <div className="p-4 rounded-xl bg-muted/50 border border-border text-left overflow-hidden">
            <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-1 px-1">Error Message</p>
            <p className="text-xs font-mono text-muted-foreground break-all leading-normal px-1">
              {error.message}
            </p>
          </div>
        )}

        <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-4">
          {reset && (
            <button
              onClick={reset}
              className="w-full sm:w-auto px-6 py-2.5 rounded-xl bg-primary text-primary-foreground font-semibold text-sm shadow-sm hover:opacity-90 active:scale-[0.98] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Try Again
            </button>
          )}
          <button
            onClick={() => window.location.reload()}
            className="w-full sm:w-auto px-6 py-2.5 rounded-xl bg-secondary text-secondary-foreground font-semibold text-sm border border-border shadow-sm hover:bg-muted active:scale-[0.98] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Refresh Page
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Default 404 fallback shown when a route is not found.
 */
export function NotFoundComponent() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] w-full p-8 animate-in fade-in zoom-in-95 duration-300">
      <div className="w-16 h-16 rounded-2xl bg-muted border border-border flex items-center justify-center mb-6">
        <FileQuestionIcon className="w-8 h-8 text-muted-foreground" />
      </div>

      <div className="text-center space-y-4 max-w-md">
        <div className="space-y-2">
          <h2 className="font-display font-bold text-2xl tracking-tight text-foreground">
            Page not found
          </h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            The page you're looking for doesn't exist or has been moved. Let's get you back on track.
          </p>
        </div>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-6">
          <Link
            to="/"
            className="w-full sm:w-auto px-6 py-2.5 rounded-xl bg-primary text-primary-foreground font-semibold text-sm shadow-sm hover:opacity-90 active:scale-[0.98] transition-all flex items-center justify-center gap-2"
          >
            <HomeIcon size={16} />
            Go Home
          </Link>
          <button
            onClick={() => window.history.back()}
            className="w-full sm:w-auto px-6 py-2.5 rounded-xl bg-secondary text-secondary-foreground font-semibold text-sm border border-border shadow-sm hover:bg-muted active:scale-[0.98] transition-all flex items-center justify-center gap-2"
          >
            <ArrowLeftIcon size={16} />
            Go Back
          </button>
        </div>
      </div>
    </div>
  );
}
