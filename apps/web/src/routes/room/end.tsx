import { Moon02Icon, Sun01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { consumeMeetingEndSummary } from "@q9labs/chalk-react";
import { Button } from "@q9labs/chalk-ui";
import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { Calendar, Clock, Home, RotateCcw, Star, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { useTheme } from "../../context/theme";
import { ChalkLogo } from "../../components/ChalkLogo";
import { DOCS_BASE_URL } from "../../lib/docsRedirect";

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
    roomId?: string;
  }>({});

  useEffect(() => {
    const summary = consumeMeetingEndSummary({ roomId });
    if (!summary) {
      return;
    }

    setMeetingData({
      duration: summary.durationSeconds,
      participantCount: summary.participantCount,
      roomName: summary.roomName || undefined,
      roomId: summary.roomId || roomId,
    });
  }, [roomId]);

  const effectiveRoomId = roomId || meetingData.roomId;

  const handleRejoin = () => {
    if (effectiveRoomId) {
      window.location.assign(`/room/${encodeURIComponent(effectiveRoomId)}`);
    }
  };

  const handleNewMeeting = () => {
    window.open("/new", "_blank", "noopener,noreferrer");
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
    <div className="font-app flex h-screen flex-col bg-background text-foreground selection:bg-primary/20 overflow-hidden">
      {/* Header */}
      <header className="shrink-0 w-full border-b border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between max-w-7xl">
          <Link to="/">
            <ChalkLogo />
          </Link>
          <div className="flex items-center gap-6">
            <nav className="hidden md:flex items-center gap-6 text-sm font-medium">
              <Link to="/room/$roomId" params={{ roomId: "abc" }} className="text-muted-foreground hover:text-foreground transition-colors">
                Room
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

      <main className="flex-1 flex flex-col items-center justify-center p-4">
        <div className="max-w-3xl w-full text-center space-y-12">
          <div className="space-y-4">
            <h1 className="text-4xl md:text-6xl font-bold tracking-tight text-foreground balance-text">Meeting complete.</h1>
            <p className="text-lg text-muted-foreground max-w-xl mx-auto balance-text">Your session has ended successfully. Thank you for using Chalk.</p>
          </div>

          {/* Stats Section */}
          {hasMeetingStats && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-px bg-border/40 border border-border/40 rounded-2xl overflow-hidden shadow-sm max-w-2xl mx-auto w-full">
              {meetingData.duration !== undefined && (
                <div className="bg-background p-6 space-y-1">
                  <div className="flex items-center justify-center gap-2 text-muted-foreground mb-1">
                    <Clock className="h-4 w-4" />
                    <span className="text-xs font-medium uppercase tracking-wider">Duration</span>
                  </div>
                  <div className="text-2xl font-semibold">{formatDuration(meetingData.duration)}</div>
                </div>
              )}
              {meetingData.participantCount !== undefined && (
                <div className="bg-background p-6 space-y-1">
                  <div className="flex items-center justify-center gap-2 text-muted-foreground mb-1">
                    <Users className="h-4 w-4" />
                    <span className="text-xs font-medium uppercase tracking-wider">Attendees</span>
                  </div>
                  <div className="text-2xl font-semibold">{meetingData.participantCount}</div>
                </div>
              )}
              <div className="bg-background p-6 space-y-1">
                <div className="flex items-center justify-center gap-2 text-muted-foreground mb-1">
                  <Calendar className="h-4 w-4" />
                  <span className="text-xs font-medium uppercase tracking-wider">Date</span>
                </div>
                <div className="text-2xl font-semibold">
                  {new Date().toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })}
                </div>
              </div>
            </div>
          )}

          {/* Feedback Section */}
          <div className="bg-secondary/20 border border-border/40 rounded-3xl p-8 max-w-xl mx-auto w-full space-y-6">
            <div className="space-y-1">
              <h3 className="text-lg font-semibold">{feedbackSubmitted ? "Feedback received" : "How was the quality?"}</h3>
              <p className="text-sm text-muted-foreground">{feedbackSubmitted ? "Thank you for helping us improve Chalk." : "Let us know how your experience was."}</p>
            </div>

            <div className="flex justify-center gap-3">
              {[1, 2, 3, 4, 5].map((star) => (
                <button
                  key={star}
                  type="button"
                  disabled={feedbackSubmitted}
                  onClick={() => handleRatingClick(star)}
                  onMouseEnter={() => setHoveredRating(star)}
                  onMouseLeave={() => setHoveredRating(0)}
                  className={`p-1 transition-all duration-200 focus:outline-none ${feedbackSubmitted ? "cursor-default" : "hover:scale-110 active:scale-95"}`}
                  aria-label={`Rate ${star} star${star !== 1 ? "s" : ""}`}
                >
                  <Star className={`h-10 w-10 transition-colors ${star <= displayRating ? "fill-primary text-primary" : "text-muted-foreground/20"}`} />
                </button>
              ))}
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-4">
            <Button size="lg" variant="secondary" className="w-full sm:w-auto px-8 h-12 font-medium" onClick={handleNewMeeting}>
              Start New Meeting
            </Button>
            {effectiveRoomId && (
              <Button size="lg" variant="secondary" className="w-full sm:w-auto px-8 h-12 font-medium" onClick={handleRejoin}>
                <RotateCcw className="h-4 w-4 mr-2" />
                Rejoin Meeting
              </Button>
            )}
            <Button size="lg" variant="secondary" className="w-full sm:w-auto px-8 h-12 font-medium" onClick={handleGoHome}>
              <Home className="h-4 w-4 mr-2" />
              Home
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
            <Link to="/room/$roomId" params={{ roomId: "abc" }} className="hover:text-foreground transition-colors">
              Room
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
}
