import { createFileRoute } from "@tanstack/react-router";
import { useState, useCallback } from "react";
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
} from "@chalk/ui";
import { Input } from "@chalk/ui";
import { Field, FieldGroup, FieldLabel } from "@chalk/ui";
import { Badge } from "@chalk/ui";

export const Route = createFileRoute("/demo")({ component: DemoPage });

function DemoPage() {
  return (
    <ChalkProvider debug>
      <div className="min-h-screen bg-background p-8">
        <div className="mx-auto max-w-6xl space-y-8">
          <header className="text-center">
            <h1 className="text-4xl font-bold tracking-tight">Chalk SDK Demo</h1>
            <p className="text-muted-foreground mt-2">
              Video conferencing powered by @chalk/react
            </p>
          </header>
          <DemoContent />
        </div>
      </div>
    </ChalkProvider>
  );
}

function DemoContent() {
  const { room, isConnected, joinRoom, leaveRoom } = useChalk();
  const [displayName, setDisplayName] = useState("");
  const [roomId, setRoomId] = useState("demo-room-001");
  const [isJoining, setIsJoining] = useState(false);

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
    return <MeetingRoom onLeave={handleLeave} />;
  }

  return (
    <div className="flex items-center justify-center">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Join a Room</CardTitle>
          <CardDescription>
            Enter your name and room ID to start or join a video call
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleJoin();
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="display-name">Your Name</FieldLabel>
                <Input
                  id="display-name"
                  placeholder="Enter your name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="room-id">Room ID</FieldLabel>
                <Input
                  id="room-id"
                  placeholder="Enter room ID"
                  value={roomId}
                  onChange={(e) => setRoomId(e.target.value)}
                  required
                />
              </Field>
              <Button type="submit" className="w-full" disabled={isJoining}>
                {isJoining ? "Joining..." : "Join Room"}
              </Button>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function MeetingRoom({ onLeave }: { onLeave: () => void }) {
  const { room, status, isRecording } = useRoom();
  const { participants, localParticipant, activeSpeaker, participantCount } =
    useParticipants();
  const {
    isVideoEnabled,
    isAudioEnabled,
    isScreenSharing,
    toggleVideo,
    toggleAudio,
    startScreenShare,
    stopScreenShare,
  } = useMedia();
  const { cameras, microphones, selectedCamera, selectedMicrophone, selectCamera, selectMicrophone } =
    useDevices();
  const { isRecording: recordingActive, startRecording, stopRecording, durationSeconds } =
    useRecording();

  // Combine local participant with remote participants for the grid
  const allParticipants = localParticipant
    ? [localParticipant, ...participants.filter((p) => !p.isLocal)]
    : participants;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h2 className="text-2xl font-semibold">Room: {room?.id}</h2>
          <div className="flex items-center gap-2">
            <Badge variant={status === "connected" ? "default" : "secondary"}>
              {status}
            </Badge>
            <span className="text-sm text-muted-foreground">
              {participantCount} participant{participantCount !== 1 ? "s" : ""}
            </span>
            {recordingActive && (
              <Badge variant="destructive">
                Recording {durationSeconds}s
              </Badge>
            )}
          </div>
        </div>
        <Button variant="outline" onClick={onLeave}>
          Leave Room
        </Button>
      </div>

      {/* Video Grid */}
      <div className="aspect-video w-full rounded-xl bg-muted/50 overflow-hidden">
        {allParticipants.length > 0 ? (
          <VideoGrid
            participants={allParticipants}
            layout={activeSpeaker ? "spotlight" : "grid"}
            spotlightId={activeSpeaker?.id}
            tileProps={{
              showName: true,
              showStatus: true,
            }}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            Waiting for participants...
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="flex items-center justify-center gap-4">
        <Controls
          showAudio
          showVideo
          showScreenShare
          showRecording
          onLeave={onLeave}
        />
      </div>

      {/* Device Selection */}
      <div className="grid grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Camera</CardTitle>
          </CardHeader>
          <CardContent>
            <select
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={selectedCamera ?? ""}
              onChange={(e) => selectCamera(e.target.value)}
            >
              <option value="" disabled>
                Select camera
              </option>
              {cameras.map((camera) => (
                <option key={camera.deviceId} value={camera.deviceId}>
                  {camera.label}
                </option>
              ))}
            </select>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Microphone</CardTitle>
          </CardHeader>
          <CardContent>
            <select
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={selectedMicrophone ?? ""}
              onChange={(e) => selectMicrophone(e.target.value)}
            >
              <option value="" disabled>
                Select microphone
              </option>
              {microphones.map((mic) => (
                <option key={mic.deviceId} value={mic.deviceId}>
                  {mic.label}
                </option>
              ))}
            </select>
          </CardContent>
        </Card>
      </div>

      {/* Local Participant Info */}
      {localParticipant && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Your Status</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              <Badge variant={isVideoEnabled ? "default" : "secondary"}>
                {isVideoEnabled ? "Camera On" : "Camera Off"}
              </Badge>
              <Badge variant={isAudioEnabled ? "default" : "secondary"}>
                {isAudioEnabled ? "Mic On" : "Mic Off"}
              </Badge>
              {isScreenSharing && <Badge variant="default">Sharing Screen</Badge>}
              {localParticipant.handRaised && (
                <Badge variant="default">Hand Raised</Badge>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
