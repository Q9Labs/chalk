import { Moon02Icon, Sun01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@q9labs/chalk-ui";
import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { Calendar, Clock, Home, RotateCcw, Star, Users, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { useTheme } from "../../context/theme";
import { ChalkLogo } from "../../components/ChalkLogo";
import { EdgeNetworkIllustration } from "../../components/EdgeNetworkIllustration";

export const Route = createFileRoute("/room/end")({
  component: MeetingEndPage,
  validateSearch: (search: Record<string, unknown>) => ({
    roomId: typeof search.roomId === "string" ? search.roomId : undefined,
  }),
});

function formatDuration(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) {
    const remainingMins = minutes % 60;
    return `${hours}h ${remainingMins}m`;
  }
  return `${minutes}m`;
}

function MeetingEndPage() {
  const navigate = useNavigate();
  const { roomId } = Route.useSearch();
  const { theme, toggleTheme } = useTheme();

  const [rating, setRating] = useState(0);
  const [hoveredRating, setHoveredRating] = useState(0);
  const [feedbackSubmitted, setFeedbackSubmitted] = useState(false);
  const [meetingData, setMeetingData] = useState<{
    duration?: number;
    participantCount?: number;
    roomName?: string;
  }>({});

  useEffect(() => {
    const stored = localStorage.getItem("data");
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        setMeetingData({
          duration: parsed.duration,
          participantCount: parsed.participantCount,
          roomName: parsed.roomName || roomId,
        });
      } catch {
        // ignore
      }
    }
  }, [roomId]);

  const handleRejoin = () => {
    if (roomId) {
      window.location.assign(`/room/${encodeURIComponent(roomId)}`);
    }
  };

  const handleNewMeeting = () => {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let newRoomId = "room-";
    for (let i = 0; i < 8; i++) {
      newRoomId += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    window.open(`/room/${newRoomId}`, "_blank", "noopener,noreferrer");
  };

  const handleGoHome = () => {
    navigate({ to: "/" });
  };

  const handleRatingClick = (value: number) => {
    setRating(value);
    setFeedbackSubmitted(true);
  };

  const displayRating = hoveredRating || rating;
  const hasMeetingStats = meetingData.duration !== undefined || meetingData.participantCount !== undefined;

  return (
    <div className="font-app flex h-screen flex-col bg-background selection:bg-primary/20 overflow-hidden relative">
      {/* Premium Background Atmosphere */}
      <div className="fixed inset-0 pointer-events-none -z-10">
        <div className="absolute top-[-20%] left-[-10%] w-[60%] h-[60%] bg-primary/10 rounded-full blur-[140px]" />
        <div className="absolute bottom-[-20%] right-[-10%] w-[60%] h-[60%] bg-blue-500/5 rounded-full blur-[140px]" />
      </div>

      {/* Background Illustration */}
      <div className="absolute inset-0 z-0 opacity-40 dark:opacity-20 pointer-events-none">
        <EdgeNetworkIllustration />
      </div>

      {/* Soft Floating Header */}
      <header className="fixed top-0 z-50 w-full flex justify-center py-6 pointer-events-none">
        <div className="container mx-auto px-6 max-w-6xl pointer-events-auto">
          <div className="glass-hud px-8 h-16 rounded-full flex items-center justify-between border border-white/10 shadow-2xl backdrop-blur-2xl">
            <Link to="/">
              <ChalkLogo />
            </Link>
            <div className="flex items-center gap-4">
              <button type="button" onClick={toggleTheme} className="p-2 text-muted-foreground hover:text-foreground transition-colors">
                <HugeiconsIcon icon={theme === "dark" ? Sun01Icon : Moon02Icon} size={18} />
              </button>
              <Button size="sm" onClick={handleNewMeeting} className="rounded-full px-6 font-bold shadow-primary/20 hover:shadow-xl active:scale-95 transition-all">
                New Meeting
              </Button>
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center relative z-10 px-6">
        <div className="max-w-4xl w-full text-center space-y-12 animate-in fade-in slide-in-from-bottom-4 duration-1000">
          <div className="space-y-4">
            <h1 className="text-6xl sm:text-8xl lg:text-[7.5rem] font-black tracking-tight leading-[0.85] text-foreground">
              SESSION <br />
              <span className="text-primary italic">COMPLETE.</span>
            </h1>
            <p className="text-xl lg:text-2xl text-muted-foreground font-medium max-w-2xl mx-auto">
              Your call has ended successfully. See you on the edge.
            </p>
          </div>

          {/* Stats Pill */}
          {hasMeetingStats && (
            <div className="inline-flex items-center gap-8 px-8 py-4 glass-hud border border-white/10 rounded-full shadow-xl animate-in fade-in slide-in-from-bottom-6 duration-1000 delay-200">
              {meetingData.duration !== undefined && (
                <div className="flex items-center gap-2">
                  <Clock className="h-4 w-4 text-primary" />
                  <span className="text-sm font-black uppercase tracking-widest">{formatDuration(meetingData.duration)}</span>
                </div>
              )}
              {meetingData.participantCount !== undefined && (
                <div className="flex items-center gap-2 border-l border-white/10 pl-8">
                  <Users className="h-4 w-4 text-primary" />
                  <span className="text-sm font-black uppercase tracking-widest">{meetingData.participantCount} attendees</span>
                </div>
              )}
              <div className="flex items-center gap-2 border-l border-white/10 pl-8">
                <Calendar className="h-4 w-4 text-primary" />
                <span className="text-sm font-black uppercase tracking-widest">
                  {new Date().toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })}
                </span>
              </div>
            </div>
          )}

          {/* Feedback Section */}
          <div className="space-y-6 animate-in fade-in slide-in-from-bottom-8 duration-1000 delay-400">
            <h3 className="text-[11px] font-black uppercase tracking-[0.3em] text-muted-foreground/50">
              {feedbackSubmitted ? "Thanks for your feedback!" : "How was the quality?"}
            </h3>

            <div className="flex justify-center gap-2">
              {[1, 2, 3, 4, 5].map((star) => (
                <button
                  key={star}
                  type="button"
                  disabled={feedbackSubmitted}
                  onClick={() => handleRatingClick(star)}
                  onMouseEnter={() => setHoveredRating(star)}
                  onMouseLeave={() => setHoveredRating(0)}
                  className={`p-2 transition-all duration-300 focus:outline-none ${feedbackSubmitted ? "opacity-50 cursor-default" : "hover:scale-125 active:scale-95"}`}
                  aria-label={`Rate ${star} star${star !== 1 ? "s" : ""}`}
                >
                  <Star
                    className={`h-10 w-10 transition-colors ${
                      star <= displayRating ? "fill-primary text-primary filter drop-shadow-[0_0_8px_rgba(var(--primary),0.5)]" : "text-muted-foreground/20"
                    }`}
                  />
                </button>
              ))}
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-6 pt-8 animate-in fade-in slide-in-from-bottom-10 duration-1000 delay-600">
            <Button size="lg" className="h-16 px-12 rounded-full text-lg font-black shadow-2xl shadow-primary/30 group relative overflow-hidden" onClick={handleNewMeeting}>
              <div className="absolute inset-0 bg-primary/20 animate-pulse" />
              <span className="relative flex items-center gap-2">
                Start New Meeting
                <ChevronRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
              </span>
            </Button>
            <Button size="lg" variant="outline" className="h-16 px-12 rounded-full text-lg font-black border-white/10 glass-hud hover:bg-white/5 transition-all" onClick={handleGoHome}>
              <span className="flex items-center gap-2">
                <Home className="h-5 w-5" />
                Back to Home
              </span>
            </Button>
          </div>

          {roomId && (
            <div className="animate-in fade-in duration-1000 delay-1000">
              <button
                type="button"
                onClick={handleRejoin}
                className="inline-flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-muted-foreground hover:text-primary transition-colors group"
              >
                <RotateCcw className="h-3 w-3 group-hover:rotate-[-45deg] transition-transform" />
                Rejoin previous session
              </button>
            </div>
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="fixed bottom-0 w-full py-10 px-12 pointer-events-none">
        <div className="container mx-auto max-w-6xl flex flex-col md:flex-row justify-between items-center gap-8 pointer-events-auto">
          <nav className="flex gap-12 text-[10px] font-black uppercase tracking-widest text-muted-foreground">
            <Link to="/documentation" className="hover:text-primary transition-colors">
              Documentation
            </Link>
            <a href="/privacy" className="hover:text-primary transition-colors">
              Privacy
            </a>
            <a href="/terms" className="hover:text-primary transition-colors">
              Terms
            </a>
          </nav>
          <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground/30">© {new Date().getFullYear()} Chalk Edge Network</p>
        </div>
      </footer>
    </div>
  );
}
