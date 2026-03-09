import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { WifiOff } from "lucide-react";
import { z } from "zod";

const errorSearchSchema = z.object({
  message: z.string().optional(),
  roomId: z.string().optional(),
});

export const Route = createFileRoute("/room/error")({
  validateSearch: errorSearchSchema,
  component: RoomErrorPage,
});

function RoomErrorPage() {
  const navigate = useNavigate();
  const { message, roomId } = Route.useSearch();

  const errorMessage = message || "An unknown error occurred while connecting to the room.";

  const handleRetry = () => {
    if (roomId) {
      window.location.assign(`/room/${encodeURIComponent(roomId)}`);
    } else {
      navigate({ to: "/demo" });
    }
  };

  const handleGoBack = () => {
    navigate({ to: "/demo" });
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#121212] text-[#e8eaed] font-sans">
      <div className="flex max-w-md flex-col items-center text-center p-8">
        <div className="mb-6 rounded-full bg-[#ea4335]/10 p-4">
          <WifiOff className="h-12 w-12 text-[#ea4335]" />
        </div>
        <h1 className="mb-2 text-2xl font-normal">Connection Error</h1>
        <p className="mb-8 text-[#9aa0a6] leading-relaxed">{errorMessage}</p>

        <div className="flex flex-col gap-3 w-full sm:flex-row sm:w-auto">
          <button type="button" onClick={handleRetry} className="flex-1 px-4 py-2 rounded-lg bg-[#8ab4f8] text-[#202124] font-medium hover:bg-[#a8c7fa] transition-colors focus:outline-none focus:ring-2 focus:ring-[#8ab4f8]/50">
            Retry
          </button>
          <button type="button" onClick={handleGoBack} className="flex-1 px-4 py-2 rounded-lg bg-[#202124] text-white font-medium hover:bg-[#303134] transition-colors focus:outline-none focus:ring-2 focus:ring-[#202124]/50 border border-[#303134]">
            Back to Lobby
          </button>
        </div>
      </div>
    </div>
  );
}

export default RoomErrorPage;
