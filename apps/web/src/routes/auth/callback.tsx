import { createFileRoute, Link } from "@tanstack/react-router";
import z from "zod";
import { ChalkLogo } from "../../components/ChalkLogo";

export const Route = createFileRoute("/auth/callback")({
  component: AuthCallbackPage,
  validateSearch: z.object({
    token: z.string().optional(),
    error: z.string().optional(),
  }),
});

function AuthCallbackPage() {
  const { error } = Route.useSearch();

  return (
    <div className="font-app min-h-screen bg-background flex flex-col items-center justify-center p-6 relative overflow-hidden selection:bg-primary/20">
      <div className="absolute inset-0 z-0 flex items-center justify-center pointer-events-none">
        <div className="w-[50vw] h-[50vw] max-w-[800px] max-h-[800px] bg-primary/5 rounded-full blur-[120px] mix-blend-screen" />
      </div>

      <div className="relative z-10 flex flex-col items-center max-w-md w-full text-center space-y-6">
        <div className="relative w-24 h-24 rounded-3xl flex items-center justify-center backdrop-blur-xl border shadow-2xl bg-background/80 border-primary/30 shadow-primary/20">
          <ChalkLogo className="scale-[1.5]" />
        </div>

        <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-700 fill-mode-both">
          <h1 className="text-2xl font-black tracking-tight text-foreground">Google Sign-In Lives on Dashboard</h1>
          <p className="text-base font-medium text-muted-foreground/80 max-w-[320px] mx-auto leading-relaxed">Magic links are gone. Continue with Google from the dashboard to open your Chalk workspace.</p>

          {error && (
            <div className="p-4 rounded-xl bg-destructive/10 border border-destructive/20 text-left">
              <p className="text-xs font-mono text-destructive/90 break-all">{error}</p>
            </div>
          )}

          <Link to="/dashboard" className="inline-flex w-full items-center justify-center h-12 rounded-full bg-background border border-border hover:bg-muted font-bold text-sm transition-colors">
            Return to Dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
