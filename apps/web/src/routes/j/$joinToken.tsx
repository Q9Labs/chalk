import { createFileRoute, Link } from "@tanstack/react-router";
import * as v from "valibot";

const joinParamsSchema = v.object({
  joinToken: v.string(),
});

export const Route = createFileRoute("/j/$joinToken")({
  component: JoinLinkPage,
  params: {
    parse: (params) => v.parse(joinParamsSchema, params),
  },
});

function JoinLinkPage() {
  const { joinToken } = Route.useParams();

  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-3xl border border-border/60 bg-card/80 p-6 shadow-2xl backdrop-blur-sm space-y-4 text-center">
        <p className="text-xs font-medium uppercase tracking-[0.28em] text-primary/80">Invite link</p>
        <h1 className="text-3xl font-semibold leading-tight">Join handling is not wired yet</h1>
        <p className="text-sm text-muted-foreground">The stale web-side join exchange and mobile redirect logic has been removed while the SDK contract is rebuilt.</p>
        <code className="block rounded-xl bg-muted px-3 py-2 text-xs text-muted-foreground break-all">{joinToken}</code>
        <Link to="/" className="inline-flex min-h-11 items-center justify-center rounded-2xl bg-primary px-4 text-sm font-semibold text-primary-foreground transition hover:opacity-95">
          Back home
        </Link>
      </div>
    </div>
  );
}
