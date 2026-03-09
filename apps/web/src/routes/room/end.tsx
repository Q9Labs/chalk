import { Moon02Icon, Sun01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button, Card, CardDescription, CardHeader, CardTitle } from "@q9labs/chalk-ui";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Calendar, CheckCircle2, Clock, Home, RotateCcw, Star, Users, Video } from "lucide-react";
import { useEffect, useState } from "react";
import { useTheme } from "../../context/theme";
import { ChalkLogo } from "../../components/ChalkLogo";

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
    <div className="flex min-h-screen flex-col bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container mx-auto flex h-14 items-center justify-between px-4 sm:px-8">
          <a href="/">
            <ChalkLogo className="h-8 w-auto" />
          </a>
          <nav className="flex items-center gap-2 sm:gap-4">
            <button type="button" onClick={toggleTheme} className="p-2 rounded-full text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors" aria-label="Toggle theme">
              <HugeiconsIcon icon={theme === "dark" ? Sun01Icon : Moon02Icon} size={18} />
            </button>
            <Button size="sm" onClick={handleNewMeeting}>
              <Video className="h-4 w-4 mr-2" />
              New Meeting
            </Button>
          </nav>
        </div>
      </header>

      <main className="flex-1">
        {/* Hero Section */}
        <section className="py-16 sm:py-24">
          <div className="container mx-auto px-4 sm:px-8">
            <div className="max-w-2xl mx-auto text-center space-y-6">
              <div className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-primary/10 text-primary">
                <CheckCircle2 className="h-8 w-8" />
              </div>

              <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">Meeting ended</h1>

              <p className="text-lg text-muted-foreground">Thanks for using Chalk. Your call has ended successfully.</p>
            </div>
          </div>
        </section>

        {/* Stats Bar */}
        {hasMeetingStats && (
          <section className="py-8 border-y bg-muted/30">
            <div className="container mx-auto px-4 sm:px-8">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-6 text-center max-w-2xl mx-auto">
                {meetingData.duration !== undefined && (
                  <div className="flex flex-col items-center gap-2">
                    <Clock className="h-6 w-6 text-primary" />
                    <span className="text-2xl font-semibold">{formatDuration(meetingData.duration)}</span>
                    <span className="text-sm text-muted-foreground">Duration</span>
                  </div>
                )}
                {meetingData.participantCount !== undefined && (
                  <div className="flex flex-col items-center gap-2">
                    <Users className="h-6 w-6 text-primary" />
                    <span className="text-2xl font-semibold">{meetingData.participantCount}</span>
                    <span className="text-sm text-muted-foreground">Participant{meetingData.participantCount !== 1 ? "s" : ""}</span>
                  </div>
                )}
                <div className="flex flex-col items-center gap-2">
                  <Calendar className="h-6 w-6 text-primary" />
                  <span className="text-2xl font-semibold">
                    {new Date().toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })}
                  </span>
                  <span className="text-sm text-muted-foreground">Date</span>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* Feedback Section */}
        <section className="py-16 sm:py-20">
          <div className="container mx-auto px-4 sm:px-8">
            <div className="max-w-md mx-auto">
              <Card className="bg-background/60 backdrop-blur-sm">
                <CardHeader className="text-center">
                  <CardTitle className="text-xl">{feedbackSubmitted ? "Thanks for your feedback!" : "How was your experience?"}</CardTitle>
                  {!feedbackSubmitted && <CardDescription className="text-base mt-2">Your feedback helps us improve Chalk</CardDescription>}

                  {!feedbackSubmitted ? (
                    <div className="flex justify-center gap-1 pt-4">
                      {[1, 2, 3, 4, 5].map((star) => (
                        <button
                          key={star}
                          type="button"
                          onClick={() => handleRatingClick(star)}
                          onMouseEnter={() => setHoveredRating(star)}
                          onMouseLeave={() => setHoveredRating(0)}
                          className="p-1.5 hover:scale-110 transition-transform focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                          aria-label={`Rate ${star} star${star !== 1 ? "s" : ""}`}
                        >
                          <Star className={`h-8 w-8 transition-colors ${star <= displayRating ? "fill-yellow-400 text-yellow-400" : "text-muted-foreground/30"}`} />
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="pt-4">
                      <div className="flex justify-center gap-1">
                        {[1, 2, 3, 4, 5].map((star) => (
                          <Star key={star} className={`h-6 w-6 ${star <= rating ? "fill-yellow-400 text-yellow-400" : "text-muted-foreground/30"}`} />
                        ))}
                      </div>
                    </div>
                  )}
                </CardHeader>
              </Card>
            </div>
          </div>
        </section>

        {/* Actions Section */}
        <section className="py-16 sm:py-20 bg-primary/5 border-t">
          <div className="container mx-auto px-4 sm:px-8 text-center">
            <h2 className="text-2xl font-bold tracking-tight sm:text-3xl mb-4">What's next?</h2>
            <p className="text-muted-foreground mb-8 max-w-md mx-auto">Start another meeting or head back to the homepage.</p>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <Button size="lg" className="h-12 px-8 text-base shadow-lg shadow-primary/20" onClick={handleNewMeeting}>
                <Video className="h-5 w-5 mr-2" />
                Start New Meeting
              </Button>
              <Button size="lg" variant="outline" className="h-12 px-8 text-base" onClick={handleGoHome}>
                <Home className="h-5 w-5 mr-2" />
                Back to Home
              </Button>
            </div>

            {roomId && (
              <div className="mt-8 pt-8 border-t border-border/50 max-w-md mx-auto">
                <button type="button" onClick={handleRejoin} className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
                  <RotateCcw className="h-4 w-4" />
                  Rejoin previous meeting
                </button>
              </div>
            )}
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t py-8 bg-muted/10">
        <div className="container mx-auto px-4 sm:px-8">
          <div className="flex flex-col md:flex-row justify-between items-center gap-6">
            <ChalkLogo className="h-6 w-auto opacity-75" />
            <nav className="flex items-center gap-6 text-sm text-muted-foreground">
              <a href="/docs" className="hover:text-foreground transition-colors">
                Docs
              </a>
              <a href="/privacy" className="hover:text-foreground transition-colors">
                Privacy
              </a>
              <a href="/terms" className="hover:text-foreground transition-colors">
                Terms
              </a>
            </nav>
            <p className="text-sm text-muted-foreground">© {new Date().getFullYear()} Chalk</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
