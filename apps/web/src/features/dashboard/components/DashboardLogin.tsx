import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@q9labs/chalk-ui";
import { InformationCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Loader2 } from "lucide-react";
import { ChalkLogo } from "../../../components/ChalkLogo";

interface DashboardLoginProps {
  onSignIn: () => void;
  isSigningIn: boolean;
}

export function DashboardLogin({ onSignIn, isSigningIn }: DashboardLoginProps) {
  return (
    <div className="font-app min-h-screen flex items-center justify-center p-6 relative overflow-hidden bg-background text-foreground selection:bg-primary/20">
      {/* Stark background accent */}
      <div className="absolute inset-0 z-0 pointer-events-none flex items-center justify-center opacity-40 dark:opacity-20 blur-[100px]">
        <div className="w-[400px] h-[400px] bg-primary/20 rounded-full animate-pulse" />
      </div>

      <div className="w-full max-w-md relative z-10 animate-in fade-in slide-in-from-bottom-8 duration-700 ease-out">
        <Card className="bg-background/80 backdrop-blur-xl border-border/50 shadow-2xl rounded-[1.5rem] overflow-hidden">
          <CardHeader className="text-center pb-6 pt-12 px-10">
            <div className="mx-auto mb-8 flex justify-center">
              <ChalkLogo />
            </div>
            
            <div className="space-y-2">
              <CardTitle className="text-3xl font-bold tracking-tight text-foreground">
                Welcome Back
              </CardTitle>
              <CardDescription className="text-base font-medium text-muted-foreground">
                Sign in to access your creative workspace.
              </CardDescription>
            </div>
          </CardHeader>

          <CardContent className="space-y-8 px-10 pb-12">
            <div className="space-y-4">
              <Button
                onClick={onSignIn}
                disabled={isSigningIn}
                size="lg"
                className="w-full h-14 rounded-xl font-bold text-base shadow-sm hover:-translate-y-0.5 active:translate-y-0.5 transition-all"
              >
                {isSigningIn ? (
                  <span className="flex items-center justify-center gap-3">
                    <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
                    Connecting...
                  </span>
                ) : (
                  <span className="flex items-center justify-center gap-3">
                    Continue with Google
                  </span>
                )}
              </Button>

              <div className="p-4 rounded-xl bg-secondary border border-border/50 flex gap-4">
                <HugeiconsIcon icon={InformationCircleIcon} size={20} className="text-muted-foreground shrink-0 mt-0.5" />
                <p className="text-sm font-medium text-muted-foreground leading-snug text-balance">
                  Use your Chalk Google workspace account. Access is restricted to authorized team members.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
