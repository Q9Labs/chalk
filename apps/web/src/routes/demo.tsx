import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useCallback, useEffect } from "react";
import {
  ChalkProvider,
  useChalk,
  useRoom,
  useParticipants,
  useMedia,
  useDevices,
  useRecording,
  VideoGrid,
  Controls,
} from "@chalk/react";
import { Button } from "@chalk/ui";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CardFooter,
} from "@chalk/ui";
import { Input } from "@chalk/ui";
import { Field, FieldGroup, FieldLabel } from "@chalk/ui";
import { Badge } from "@chalk/ui";
import { Settings, Users, ArrowLeft, Mic, Video, Monitor, Radio, Copy } from "lucide-react";

export const Route = createFileRoute("/demo")({ component: DemoPage });

function DemoPage() {
  return (
    <ChalkProvider debug>
      <div className="min-h-screen bg-background text-foreground font-sans">
        <DemoContent />
      </div>
    </ChalkProvider>
  );
}

function DemoContent() {
  const { room, isConnected, joinRoom, leaveRoom } = useChalk();
  const [displayName, setDisplayName] = useState("");
  const [roomId, setRoomId] = useState("demo-room-001");
  const [isJoining, setIsJoining] = useState(false);

  // Prefill random room ID if empty
  useEffect(() => {
    if (!roomId) {
      setRoomId(`room-${Math.floor(Math.random() * 10000)}`);
    }
  }, []);

  const handleJoin = useCallback(async () => {
    if (!displayName.trim() || !roomId.trim()) return;

    setIsJoining(true);
    try {
      await joinRoom(roomId, {
        displayName: displayName.trim(),
        audio: true,
        video: true,
      });
    } catch (error) {
      console.error("Failed to join room:", error);
    } finally {
      setIsJoining(false);
    }
  }, [displayName, roomId, joinRoom]);

  const handleLeave = useCallback(() => {
    leaveRoom();
  }, [leaveRoom]);

  if (isConnected && room) {
    return <MeetingRoom onLeave={handleLeave} roomId={roomId} />;
  }

  return (
    <div className="flex min-h-screen flex-col bg-muted/30">
        <header className="flex h-16 items-center border-b bg-background px-6">
            <Link to="/" className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors">
                <ArrowLeft className="h-4 w-4" />
                Back to Home
            </Link>
        </header>

      <main className="flex-1 flex items-center justify-center p-4">
        <div className="grid w-full max-w-5xl gap-12 lg:grid-cols-2 lg:items-center">
            <div className="space-y-6 max-w-md mx-auto lg:mx-0">
                <h1 className="text-4xl font-bold tracking-tight">
                    Start your instant meeting
                </h1>
                <p className="text-lg text-muted-foreground">
                    Experience ultra low-latency video calls. No sign-up required. Just enter a name and a room ID.
                </p>
                <div className="flex gap-4 text-sm text-muted-foreground">
                    <div className="flex items-center gap-2">
                        <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center text-primary">
                            <Video className="h-4 w-4" />
                        </div>
                        HD Video
                    </div>
                    <div className="flex items-center gap-2">
                        <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center text-primary">
                            <Mic className="h-4 w-4" />
                        </div>
                        Clear Audio
                    </div>
                    <div className="flex items-center gap-2">
                        <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center text-primary">
                            <Monitor className="h-4 w-4" />
                        </div>
                        Screen Share
                    </div>
                </div>
            </div>

            <Card className="w-full max-w-md mx-auto border-muted shadow-xl">
            <CardHeader>
                <CardTitle className="text-xl">Join Meeting</CardTitle>
                <CardDescription>
                Configure your session settings below
                </CardDescription>
            </CardHeader>
            <CardContent>
                <form
                onSubmit={(e) => {
                    e.preventDefault();
                    handleJoin();
                }}
                className="space-y-4"
                >
                <FieldGroup>
                    <Field>
                    <FieldLabel htmlFor="display-name">Display Name</FieldLabel>
                    <Input
                        id="display-name"
                        placeholder="e.g. Alice Smith"
                        value={displayName}
                        onChange={(e) => setDisplayName(e.target.value)}
                        required
                    />
                    </Field>
                    <Field>
                    <FieldLabel htmlFor="room-id">Room ID</FieldLabel>
                    <div className="flex gap-2">
                        <Input
                        id="room-id"
                        placeholder="room-name"
                        value={roomId}
                        onChange={(e) => setRoomId(e.target.value)}
                        required
                        className="font-mono flex-1"
                        />
                         <Button type="button" variant="outline" size="icon" className="shrink-0" onClick={() => navigator.clipboard.writeText(roomId)}>
                            <Copy className="h-4 w-4" />
                         </Button>
                    </div>
                    </Field>
                </FieldGroup>
                
                <div className="pt-2">
                    <Button type="submit" size="lg" className="w-full text-base" disabled={isJoining}>
                        {isJoining ? "Joining Room..." : "Join Room"}
                    </Button>
                </div>
                </form>
            </CardContent>
            </Card>
        </div>
      </main>
    </div>
  );
}

function MeetingRoom({ onLeave, roomId }: { onLeave: () => void, roomId: string }) {
  const { status } = useRoom();
  const { participants, localParticipant, activeSpeaker, participantCount } =
    useParticipants();
  const {
    isVideoEnabled,
    isAudioEnabled,
    isScreenSharing,
  } = useMedia();
  const { cameras, microphones, selectedCamera, selectedMicrophone, selectCamera, selectMicrophone } =
    useDevices();
  const { isRecording: recordingActive, durationSeconds } =
    useRecording();

  const [showSettings, setShowSettings] = useState(false);

  // Combine local participant with remote participants for the grid
  const allParticipants = localParticipant
    ? [localParticipant, ...participants.filter((p) => !p.isLocal)]
    : participants;

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100 overflow-hidden">
      {/* Top Bar */}
      <div className="flex items-center justify-between px-4 py-3 bg-zinc-900/50 backdrop-blur border-b border-zinc-800 z-10 shrink-0">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
             <span className="font-semibold text-sm">Room: {roomId}</span>
             <Badge variant={status === "connected" ? "default" : "destructive"} className="h-5 px-1.5">
                {status}
             </Badge>
          </div>
          <div className="h-4 w-px bg-zinc-800" />
          <div className="flex items-center gap-2 text-sm text-zinc-400">
             <Users className="h-4 w-4" />
             <span>{participantCount}</span>
          </div>
          {recordingActive && (
              <Badge variant="destructive" className="animate-pulse">
                <Radio className="h-3 w-3 mr-1" />
                REC {Math.floor(durationSeconds / 60)}:{(durationSeconds % 60).toString().padStart(2, '0')}
              </Badge>
          )}
        </div>

        <div className="flex items-center gap-2">
            <Button 
                variant="ghost" 
                size="icon" 
                className="text-zinc-400 hover:text-white hover:bg-zinc-800"
                onClick={() => setShowSettings(!showSettings)}
            >
                <Settings className="h-5 w-5" />
            </Button>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 relative flex overflow-hidden">
        {/* Video Grid */}
        <div className="flex-1 flex flex-col p-4 overflow-hidden relative">
             <div className="flex-1 rounded-2xl overflow-hidden bg-zinc-900/50 border border-zinc-800/50 shadow-inner relative">
                {allParticipants.length > 0 ? (
                <VideoGrid
                    participants={allParticipants}
                    layout={activeSpeaker ? "spotlight" : "grid"}
                    spotlightId={activeSpeaker?.id}
                    tileProps={{
                    showName: true,
                    showStatus: true,
                    className: "rounded-xl overflow-hidden shadow-lg border border-zinc-800"
                    }}
                />
                ) : (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-500 gap-4">
                    <div className="h-16 w-16 rounded-full bg-zinc-900 flex items-center justify-center">
                        <Users className="h-8 w-8 opacity-50" />
                    </div>
                    <p>Waiting for others to join...</p>
                </div>
                )}
            </div>

            {/* Floating Controls */}
            <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex items-center gap-2 p-2 rounded-2xl bg-zinc-900/90 border border-zinc-800 shadow-2xl backdrop-blur-md">
                <Controls
                    showAudio
                    showVideo
                    showScreenShare
                    showRecording
                    onLeave={onLeave}
                />
            </div>
        </div>

        {/* Settings Panel (Collapsible) */}
        {showSettings && (
            <div className="w-80 bg-zinc-900 border-l border-zinc-800 p-4 space-y-6 overflow-y-auto">
                <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-zinc-100">Settings</h3>
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setShowSettings(false)}>
                        <ArrowRight className="h-4 w-4" />
                    </Button>
                </div>

                <div className="space-y-4">
                    <div className="space-y-2">
                        <label className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Camera</label>
                        <select
                            className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:ring-2 focus:ring-primary"
                            value={selectedCamera ?? ""}
                            onChange={(e) => selectCamera(e.target.value)}
                            >
                            {cameras.map((camera) => (
                                <option key={camera.deviceId} value={camera.deviceId}>
                                {camera.label || `Camera ${camera.deviceId.slice(0, 5)}...`}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className="space-y-2">
                        <label className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Microphone</label>
                        <select
                            className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:ring-2 focus:ring-primary"
                            value={selectedMicrophone ?? ""}
                            onChange={(e) => selectMicrophone(e.target.value)}
                            >
                            {microphones.map((mic) => (
                                <option key={mic.deviceId} value={mic.deviceId}>
                                {mic.label || `Mic ${mic.deviceId.slice(0, 5)}...`}
                                </option>
                            ))}
                        </select>
                    </div>

                     <div className="space-y-2 pt-4 border-t border-zinc-800">
                        <label className="text-xs font-medium text-zinc-400 uppercase tracking-wider">My Status</label>
                        <div className="flex flex-col gap-2">
                             <div className="flex items-center justify-between text-sm p-2 rounded bg-zinc-800/50">
                                <span>Camera</span>
                                <span className={isVideoEnabled ? "text-green-400" : "text-red-400"}>{isVideoEnabled ? "On" : "Off"}</span>
                             </div>
                             <div className="flex items-center justify-between text-sm p-2 rounded bg-zinc-800/50">
                                <span>Microphone</span>
                                <span className={isAudioEnabled ? "text-green-400" : "text-red-400"}>{isAudioEnabled ? "On" : "Off"}</span>
                             </div>
                             {isScreenSharing && (
                                 <div className="flex items-center justify-between text-sm p-2 rounded bg-blue-500/20 text-blue-300">
                                    <span>Screen Share</span>
                                    <span>Active</span>
                                 </div>
                             )}
                        </div>
                    </div>
                </div>
            </div>
        )}
      </div>
    </div>
  );
}
