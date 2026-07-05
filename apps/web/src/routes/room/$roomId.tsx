import { Calendar01Icon, Clock01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { createFileRoute, Link } from "@tanstack/react-router";
import * as v from "valibot";
import { ChalkLogo } from "../../components/ChalkLogo";

const optionalBooleanSearchParam = v.optional(
  v.pipe(
    v.unknown(),
    v.transform((value) => value === true || value === "true"),
  ),
);

const roomParamsSchema = v.object({
  roomId: v.string(),
});

export const Route = createFileRoute("/room/$roomId")({
  component: RoomPage,
  params: {
    parse: (params) => v.parse(roomParamsSchema, params),
  },
  validateSearch: v.object({
    roomName: v.optional(v.string()),
    autoJoin: optionalBooleanSearchParam,
  }),
});

function RoomPage() {
  const { roomId } = Route.useParams();
  const { roomName } = Route.useSearch();

  return (
    <div className="min-h-screen bg-black flex flex-col items-center justify-center p-6 relative overflow-hidden selection:bg-primary/20 text-white">
      <div className="absolute inset-0 z-0">
        <div className="absolute top-[20%] left-[10%] h-[50vw] w-[50vw] rounded-full bg-primary/10 blur-[150px]" />
      </div>

      <div className="relative z-10 w-full max-w-2xl text-center space-y-10 animate-in fade-in duration-1000">
        <div>
          <div className="inline-flex h-8 px-3 items-center justify-center rounded-full bg-white/10 border border-white/20 text-xs font-bold uppercase tracking-widest mb-8 backdrop-blur-md">
            <div className="w-2 h-2 rounded-full bg-primary mr-2" />
            Meeting shell
          </div>

          <h1 className="text-4xl sm:text-5xl md:text-6xl font-black tracking-tight text-balance mb-4 leading-tight">{roomName || "Meeting On Chalk"}</h1>
          <p className="mx-auto max-w-lg text-sm font-medium text-white/50">The stale web-side meeting runtime has been removed while the SDK contract is rebuilt.</p>
        </div>

        <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-6 text-left shadow-2xl backdrop-blur-md">
          <div className="grid gap-4 text-sm text-white/60">
            <div className="flex items-center gap-3">
              <HugeiconsIcon icon={Calendar01Icon} size={18} className="text-primary" />
              <span>Room route preserved</span>
            </div>
            <div className="flex items-center gap-3">
              <HugeiconsIcon icon={Clock01Icon} size={18} className="text-primary" />
              <code className="break-all rounded-lg bg-black/30 px-2 py-1 text-xs text-white/50">{roomId}</code>
            </div>
          </div>
        </div>

        <div className="flex flex-col items-center gap-6">
          <Link to="/" className="inline-flex h-11 items-center justify-center rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90">
            Back home
          </Link>
          <ChalkLogo className="opacity-30 mix-blend-screen scale-75" />
        </div>
      </div>
    </div>
  );
}

export default RoomPage;
