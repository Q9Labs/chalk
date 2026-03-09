import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import z from "zod";
import { fetchInternalAccessToken, getApiUrl, verifyMagicLink } from "../../lib/internalAuth";
import { ChalkLogo } from "../../components/ChalkLogo";
import { cn } from "../../lib/utils";

export const Route = createFileRoute("/auth/callback")({
  component: AuthCallbackPage,
  validateSearch: z.object({
    token: z.string().optional(),
    error: z.string().optional(),
  }),
});

function AuthCallbackPage() {
  const { token, error: redirectError } = Route.useSearch();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (redirectError) {
          throw new Error(redirectError);
        }

        const apiUrl = getApiUrl();
        if (token) {
          await verifyMagicLink(apiUrl, token);
        }

        const accessToken = await fetchInternalAccessToken(apiUrl);
        const meetingsResponse = await fetch(`${apiUrl}/api/v1/internal/meetings?limit=1&offset=0`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (meetingsResponse.status === 401) {
          throw new Error("Sign-in session was not established. Request a fresh link.");
        }
        if (!meetingsResponse.ok) {
          throw new Error(`dashboard auth check failed (${meetingsResponse.status})`);
        }

        if (cancelled) return;
        navigate({ to: "/dashboard", replace: true });
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [navigate, redirectError, token]);

  return (
    <div className="font-app min-h-screen bg-background flex flex-col items-center justify-center p-6 relative overflow-hidden selection:bg-primary/20">
      {/* Background Ambience */}
      <div className="absolute inset-0 z-0 flex items-center justify-center pointer-events-none">
        <div className="w-[50vw] h-[50vw] max-w-[800px] max-h-[800px] bg-primary/5 rounded-full blur-[120px] mix-blend-screen" />
      </div>

      <div className="relative z-10 flex flex-col items-center max-w-md w-full text-center">
        {/* The Pulse Animation */}
        <div className="relative flex items-center justify-center mb-12">
          {!error && (
            <>
              {/* Outer expanding rings */}
              <div className="absolute inset-0 rounded-full border border-primary/30 animate-[ping_3s_cubic-bezier(0,0,0.2,1)_infinite]" />
              <div className="absolute inset-[-20%] rounded-full border border-primary/20 animate-[ping_3s_cubic-bezier(0,0,0.2,1)_infinite] delay-700" />
              <div className="absolute inset-[-40%] rounded-full border border-primary/10 animate-[ping_3s_cubic-bezier(0,0,0.2,1)_infinite] delay-1000" />
            </>
          )}

          {/* Core Logo Container */}
          <div
            className={cn("relative w-24 h-24 rounded-3xl flex items-center justify-center backdrop-blur-xl border shadow-2xl transition-all duration-700", error ? "bg-destructive/10 border-destructive/30 shadow-destructive/20" : "bg-background/80 border-primary/30 shadow-primary/20 animate-pulse")}
          >
            <ChalkLogo className="scale-[1.5]" />
          </div>
        </div>

        {/* Status Text Area */}
        <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-700 delay-200 fill-mode-both">
          <h1 className="text-2xl font-black tracking-tight text-foreground">{error ? "Authentication Failed" : "Verifying Session"}</h1>

          <p className="text-base font-medium text-muted-foreground/80 max-w-[280px] mx-auto leading-relaxed">{error ? "We couldn't verify your magic link. It may have expired." : "Establishing a secure connection to your workspace..."}</p>

          {error && (
            <div className="pt-6 space-y-4">
              <div className="p-4 rounded-xl bg-destructive/10 border border-destructive/20 text-left">
                <p className="text-xs font-mono text-destructive/90 break-all">{error}</p>
              </div>
              <button onClick={() => navigate({ to: "/dashboard" })} className="w-full h-12 rounded-full bg-background border border-border hover:bg-muted font-bold text-sm transition-colors">
                Return to Sign In
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
