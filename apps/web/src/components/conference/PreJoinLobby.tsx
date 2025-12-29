import { Button, Card, Input, Label } from "@q9labs/chalk-ui";
import { Mic, MicOff, Video, VideoOff, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface PreJoinLobbyProps {
  roomId: string;
  onJoin: (displayName: string, roomId: string, config: MediaConfig) => void;
  isJoining: boolean;
}

export interface MediaConfig {
  audioEnabled: boolean;
  videoEnabled: boolean;
  deviceId?: {
    audio?: string;
    video?: string;
  };
}

export function PreJoinLobby({ roomId: initialRoomId, onJoin, isJoining }: PreJoinLobbyProps) {
  const [displayName, setDisplayName] = useState("");
  const [roomId, setRoomId] = useState(initialRoomId);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [videoEnabled, setVideoEnabled] = useState(true);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  
  const [audioLevel, setAudioLevel] = useState(0);

  useEffect(() => {
    let mounted = true;
    let localStream: MediaStream | null = null;

    async function initMedia() {
      try {
        if (videoEnabled || audioEnabled) {
          if (navigator.mediaDevices) {
            localStream = await navigator.mediaDevices.getUserMedia({
              video: videoEnabled,
              audio: audioEnabled
            });
            
            if (mounted) {
              setStream(localStream);
              if (videoRef.current) {
                videoRef.current.srcObject = localStream;
              }
            }
          }
        } else {
            if (mounted) {
                setStream(null);
                if (videoRef.current) {
                    videoRef.current.srcObject = null;
                }
            }
        }
      } catch (err) {
        console.error("Failed to get media", err);
      }
    }

    initMedia();

    return () => {
      mounted = false;
      if (localStream) {
        localStream.getTracks().forEach(track => { track.stop(); });
      }
    };
  }, [videoEnabled, audioEnabled]);

  useEffect(() => {
    if (!stream || !audioEnabled) {
        setAudioLevel(0);
        return;
    }

    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    const microphone = audioContext.createMediaStreamSource(stream);
    const javascriptNode = audioContext.createScriptProcessor(2048, 1, 1);

    analyser.smoothingTimeConstant = 0.8;
    analyser.fftSize = 1024;

    microphone.connect(analyser);
    analyser.connect(javascriptNode);
    javascriptNode.connect(audioContext.destination);

    javascriptNode.onaudioprocess = () => {
        const array = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(array);
        let values = 0;
        const length = array.length;
        for (let i = 0; i < length; i++) {
            values += array[i];
        }
        const average = values / length;
        setAudioLevel(average);
    }

    return () => {
        javascriptNode.disconnect();
        analyser.disconnect();
        microphone.disconnect();
        if (audioContext.state !== 'closed') {
            audioContext.close();
        }
    }
  }, [stream, audioEnabled]);

  const handleJoin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!displayName.trim() || !roomId.trim()) return;
    onJoin(displayName, roomId, { audioEnabled, videoEnabled });
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4 md:p-8">
      <div className="w-full max-w-6xl grid grid-cols-1 lg:grid-cols-2 gap-8 lg:gap-16 items-center">
        
        <div className="flex flex-col gap-6">
          <div className="space-y-2">
            <h1 className="text-3xl font-bold tracking-tight text-foreground">Get ready to join</h1>
            <p className="text-muted-foreground">Check your audio and video settings before entering.</p>
          </div>

          <div className="relative aspect-video w-full overflow-hidden rounded-2xl bg-muted shadow-2xl ring-1 ring-white/10">
            {videoEnabled ? (
              <video
                ref={videoRef}
                autoPlay
                muted
                playsInline
                className="h-full w-full object-cover transform scale-x-[-1]"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-zinc-900 text-zinc-500">
                <div className="flex flex-col items-center gap-4">
                    <div className="p-4 rounded-full bg-zinc-800">
                        <VideoOff className="h-8 w-8" />
                    </div>
                    <p>Camera is off</p>
                </div>
              </div>
            )}
            
            {audioEnabled && (
                <div className="absolute bottom-4 right-4 bg-black/50 backdrop-blur-md px-3 py-1.5 rounded-full flex items-center gap-2">
                    <Mic className={`h-4 w-4 ${audioLevel > 10 ? "text-green-400" : "text-white/50"}`} />
                    <div className="flex gap-0.5 items-end h-3">
                        {[1, 2, 3, 4, 5].map(i => (
                            <div 
                                key={i} 
                                className={`w-1 rounded-full transition-all duration-100 ${audioLevel > i * 5 ? "bg-green-400" : "bg-white/20"}`}
                                style={{ height: `${20 + i * 15}%` }}
                            />
                        ))}
                    </div>
                </div>
            )}

            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-3">
              <Button
                variant={audioEnabled ? "default" : "destructive"}
                size="icon"
                className="h-12 w-12 rounded-full shadow-lg"
                onClick={() => setAudioEnabled(!audioEnabled)}
              >
                {audioEnabled ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}
              </Button>
              <Button
                variant={videoEnabled ? "default" : "destructive"}
                size="icon"
                className="h-12 w-12 rounded-full shadow-lg"
                onClick={() => setVideoEnabled(!videoEnabled)}
              >
                {videoEnabled ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}
              </Button>
            </div>
          </div>
        </div>

        <div className="flex flex-col items-center lg:items-start max-w-md mx-auto w-full">
            <Card className="w-full border-muted/20 shadow-xl bg-card/50 backdrop-blur-sm">
                <form onSubmit={handleJoin} className="p-6 space-y-6">
                    <div className="space-y-4">
                        <div className="space-y-2">
                            <Label htmlFor="displayName" className="text-sm font-medium">Display Name</Label>
                            <Input
                                id="displayName"
                                placeholder="Enter your name"
                                value={displayName}
                                onChange={(e) => setDisplayName(e.target.value)}
                                className="h-11 bg-background/50"
                                autoFocus
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="roomId" className="text-sm font-medium">Room ID</Label>
                            <div className="relative">
                                <Input
                                    id="roomId"
                                    value={roomId}
                                    onChange={(e) => setRoomId(e.target.value)}
                                    className="h-11 font-mono bg-background/50 pr-10"
                                />
                                <div className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                                    <Users className="h-4 w-4" />
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="pt-2">
                        <Button 
                            type="submit" 
                            size="lg" 
                            className="w-full text-base font-semibold shadow-lg shadow-primary/20"
                            disabled={!displayName.trim() || !roomId.trim() || isJoining}
                        >
                            {isJoining ? (
                                <span className="flex items-center gap-2">
                                    <span className="h-4 w-4 rounded-full border-2 border-current border-t-transparent animate-spin" />
                                    Joining Room...
                                </span>
                            ) : "Join Now"}
                        </Button>
                    </div>

                    <div className="text-center">
                        <p className="text-xs text-muted-foreground">
                            By joining, you agree to our Terms of Service and Privacy Policy.
                        </p>
                    </div>
                </form>
            </Card>
        </div>
      </div>
    </div>
  );
}
