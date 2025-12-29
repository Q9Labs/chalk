import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { 
  PreJoinLobby, 
  type JoinSettings 
} from "@q9labs/chalk-react";
import { useState, useEffect, useRef } from "react";

export const Route = createFileRoute("/demo")({ 
  component: DemoPage,
});

function DemoPage() {
  const navigate = useNavigate();
  const [roomName, setRoomName] = useState("");
  
  const [videoTrack, setVideoTrack] = useState<MediaStreamTrack | null>(null);
  const [audioTrack, setAudioTrack] = useState<MediaStreamTrack | null>(null);
  const [audioLevel, setAudioLevel] = useState(0);
  
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioInputDevices, setAudioInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioOutputDevices, setAudioOutputDevices] = useState<MediaDeviceInfo[]>([]);
  
  const [selectedVideoDevice, setSelectedVideoDevice] = useState<string>("");
  const [selectedAudioInput, setSelectedAudioInput] = useState<string>("");
  const [selectedAudioOutput, setSelectedAudioOutput] = useState<string>("");

  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    const randomId = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    setRoomName(`room-${randomId}`);
  }, []);

  useEffect(() => {
    const loadDevices = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        stream.getTracks().forEach(t => { t.stop(); });

        const devices = await navigator.mediaDevices.enumerateDevices();
        setVideoDevices(devices.filter(d => d.kind === 'videoinput'));
        setAudioInputDevices(devices.filter(d => d.kind === 'audioinput'));
        setAudioOutputDevices(devices.filter(d => d.kind === 'audiooutput'));
        
        if (!selectedVideoDevice) {
            const vid = devices.find(d => d.kind === 'videoinput');
            if (vid) setSelectedVideoDevice(vid.deviceId);
        }
        if (!selectedAudioInput) {
            const mic = devices.find(d => d.kind === 'audioinput');
            if (mic) setSelectedAudioInput(mic.deviceId);
        }
      } catch (e) {
        console.error("Failed to load devices", e);
      }
    };
    loadDevices();
  }, [selectedAudioInput, selectedVideoDevice]);

  useEffect(() => {
    const startPreview = async () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => { t.stop(); });
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: selectedVideoDevice ? { deviceId: { exact: selectedVideoDevice } } : true,
          audio: selectedAudioInput ? { deviceId: { exact: selectedAudioInput } } : true
        });
        
        streamRef.current = stream;
        setVideoTrack(stream.getVideoTracks()[0] || null);
        setAudioTrack(stream.getAudioTracks()[0] || null);

        const interval = setInterval(() => {
             setAudioLevel(Math.random() * 0.5);
        }, 100);
        
        return () => clearInterval(interval);

      } catch (e) {
        console.error("Failed to start preview", e);
      }
    };
    
    startPreview();
    
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => { t.stop(); });
      }
    };
  }, [selectedVideoDevice, selectedAudioInput]);

  const handleJoin = (settings: JoinSettings) => {
    sessionStorage.setItem('chalk_display_name', settings.displayName);
    sessionStorage.setItem('chalk_video_enabled', String(settings.videoEnabled));
    sessionStorage.setItem('chalk_audio_enabled', String(settings.audioEnabled));
    
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => { t.stop(); });
    }
    
    window.location.href = `/room/${roomName}`;
  };

  const handleCancel = () => {
    navigate({ to: "/" });
  };

  return (
    <PreJoinLobby
      roomName={roomName}
      onJoin={handleJoin}
      onCancel={handleCancel}
      videoTrack={videoTrack}
      audioTrack={audioTrack}
      audioLevel={audioLevel}
      videoDevices={videoDevices}
      audioInputDevices={audioInputDevices}
      audioOutputDevices={audioOutputDevices}
      selectedVideoDevice={selectedVideoDevice}
      selectedAudioInput={selectedAudioInput}
      selectedAudioOutput={selectedAudioOutput}
      onVideoDeviceChange={setSelectedVideoDevice}
      onAudioInputChange={setSelectedAudioInput}
      onAudioOutputChange={setSelectedAudioOutput}
      initialVideoEnabled={true}
      initialAudioEnabled={true}
    />
  );
}
