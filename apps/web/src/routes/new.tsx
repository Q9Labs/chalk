import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/new")({
  component: NewRoomPage,
});

function NewRoomPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
      <div className="w-full max-w-md rounded-3xl border border-border/60 bg-card/80 p-8 text-center shadow-2xl backdrop-blur">
        <h1 className="text-2xl font-semibold text-card-foreground">Room creation is not wired yet</h1>
        <p className="mt-3 text-sm text-muted-foreground">The stale web-side room creation logic has been removed while the SDK contract is rebuilt.</p>
        <Link to="/" className="mt-6 inline-flex h-11 items-center justify-center rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90">
          Back home
        </Link>
      </div>
    </div>
  );
}
