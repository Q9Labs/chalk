import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

export interface UsePreJoinMediaParams {
  videoTrack?: MediaStreamTrack | null;
  audioTrack?: MediaStreamTrack | null;
  videoDevices: readonly MediaDeviceInfo[];
  audioInputDevices: readonly MediaDeviceInfo[];
  selectedVideoDevice?: string;
  selectedAudioInput?: string;
  isVideoEnabled: boolean;
  isAudioEnabled: boolean;
  onVideoUnavailable: () => void;
  onAudioUnavailable: () => void;
  videoRef: RefObject<HTMLVideoElement | null>;
}

export interface UsePreJoinMediaReturn {
  activeVideoTrack: MediaStreamTrack | null;
  activeAudioTrack: MediaStreamTrack | null;
  effectiveVideoDevices: MediaDeviceInfo[];
  effectiveAudioInputDevices: MediaDeviceInfo[];
}

const stopTrack = (track: MediaStreamTrack | null | undefined) => {
  if (!track) return;
  track.stop();
};

const stopOtherTracks = (stream: MediaStream, keepTrack?: MediaStreamTrack) => {
  for (const streamTrack of stream.getTracks()) {
    if (streamTrack !== keepTrack) streamTrack.stop();
  }
};

async function getUserMediaWithPreferredDevice(getUserMedia: MediaDevices["getUserMedia"], kind: "audio" | "video", preferredDeviceId: string | undefined, allowDefaultFallback: boolean): Promise<MediaStream> {
  const primaryConstraints = preferredDeviceId
    ? ({
        [kind]: { deviceId: { exact: preferredDeviceId } },
      } as MediaStreamConstraints)
    : ({
        [kind]: true,
      } as MediaStreamConstraints);

  try {
    return await getUserMedia(primaryConstraints);
  } catch (error) {
    if (!preferredDeviceId || !allowDefaultFallback) {
      throw error;
    }

    return getUserMedia({
      [kind]: true,
    } as MediaStreamConstraints);
  }
}

export function usePreJoinMedia({ videoTrack, audioTrack, videoDevices, audioInputDevices, selectedVideoDevice, selectedAudioInput, isVideoEnabled, isAudioEnabled, onVideoUnavailable, onAudioUnavailable, videoRef }: UsePreJoinMediaParams): UsePreJoinMediaReturn {
  const [localVideoTrack, setLocalVideoTrack] = useState<MediaStreamTrack | null>(null);
  const [localAudioTrack, setLocalAudioTrack] = useState<MediaStreamTrack | null>(null);
  const [localVideoDevices, setLocalVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [localAudioInputDevices, setLocalAudioInputDevices] = useState<MediaDeviceInfo[]>([]);
  const localVideoTrackRef = useRef<MediaStreamTrack | null>(null);
  const localAudioTrackRef = useRef<MediaStreamTrack | null>(null);
  localVideoTrackRef.current = localVideoTrack;
  localAudioTrackRef.current = localAudioTrack;

  const enumerateDevices = useCallback(async () => {
    try {
      const mediaDevices = navigator?.mediaDevices;
      if (!mediaDevices?.enumerateDevices) return;

      const devices = await mediaDevices.enumerateDevices();
      setLocalVideoDevices(devices.filter((device) => device.kind === "videoinput"));
      setLocalAudioInputDevices(devices.filter((device) => device.kind === "audioinput"));
    } catch {
      // Ignore enumeration errors.
    }
  }, []);

  useEffect(() => {
    void enumerateDevices();

    const mediaDevices = navigator?.mediaDevices;
    mediaDevices?.addEventListener?.("devicechange", enumerateDevices);
    return () => {
      mediaDevices?.removeEventListener?.("devicechange", enumerateDevices);
    };
  }, [enumerateDevices]);

  useEffect(() => {
    if (!isVideoEnabled || videoTrack) {
      setLocalVideoTrack((previousTrack) => {
        stopTrack(previousTrack);
        return null;
      });
      return;
    }

    const mediaDevices = navigator?.mediaDevices;
    if (!mediaDevices?.getUserMedia) {
      onVideoUnavailable();
      return;
    }

    let cancelled = false;

    void getUserMediaWithPreferredDevice(mediaDevices.getUserMedia.bind(mediaDevices), "video", selectedVideoDevice, !videoTrack && localVideoTrackRef.current === null)
      .then((stream) => {
        if (cancelled) {
          stopOtherTracks(stream);
          return;
        }

        const nextTrack = stream.getVideoTracks()[0] ?? null;
        if (!nextTrack) {
          stopOtherTracks(stream);
          return;
        }

        setLocalVideoTrack((previousTrack) => {
          if (previousTrack && previousTrack !== nextTrack) {
            stopTrack(previousTrack);
          }
          return nextTrack;
        });
        stopOtherTracks(stream, nextTrack);
        void enumerateDevices();
      })
      .catch(() => {
        if (!cancelled) onVideoUnavailable();
      });

    return () => {
      cancelled = true;
    };
  }, [isVideoEnabled, videoTrack, selectedVideoDevice, enumerateDevices, onVideoUnavailable]);

  useEffect(() => {
    if (!isAudioEnabled || audioTrack) {
      setLocalAudioTrack((previousTrack) => {
        stopTrack(previousTrack);
        return null;
      });
      return;
    }

    const mediaDevices = navigator?.mediaDevices;
    if (!mediaDevices?.getUserMedia) {
      onAudioUnavailable();
      return;
    }

    let cancelled = false;

    void getUserMediaWithPreferredDevice(mediaDevices.getUserMedia.bind(mediaDevices), "audio", selectedAudioInput, !audioTrack && localAudioTrackRef.current === null)
      .then((stream) => {
        if (cancelled) {
          stopOtherTracks(stream);
          return;
        }

        const nextTrack = stream.getAudioTracks()[0] ?? null;
        if (!nextTrack) {
          stopOtherTracks(stream);
          return;
        }

        setLocalAudioTrack((previousTrack) => {
          if (previousTrack && previousTrack !== nextTrack) {
            stopTrack(previousTrack);
          }
          return nextTrack;
        });
        stopOtherTracks(stream, nextTrack);
        void enumerateDevices();
      })
      .catch(() => {
        if (!cancelled) onAudioUnavailable();
      });

    return () => {
      cancelled = true;
    };
  }, [isAudioEnabled, audioTrack, selectedAudioInput, enumerateDevices, onAudioUnavailable]);

  useEffect(() => {
    return () => {
      stopTrack(localVideoTrackRef.current);
      stopTrack(localAudioTrackRef.current);
    };
  }, []);

  const activeVideoTrack = videoTrack ?? localVideoTrack;
  const activeAudioTrack = audioTrack ?? localAudioTrack;

  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement) return;

    if (!isVideoEnabled || !activeVideoTrack) {
      videoElement.srcObject = null;
      return;
    }

    const stream = new MediaStream([activeVideoTrack]);
    videoElement.srcObject = stream;
    void videoElement.play().catch(() => {});

    return () => {
      videoElement.srcObject = null;
    };
  }, [activeVideoTrack, isVideoEnabled, videoRef]);

  const effectiveVideoDevices = useMemo(() => (videoDevices.length > 0 ? [...videoDevices] : localVideoDevices), [videoDevices, localVideoDevices]);
  const effectiveAudioInputDevices = useMemo(() => (audioInputDevices.length > 0 ? [...audioInputDevices] : localAudioInputDevices), [audioInputDevices, localAudioInputDevices]);

  return {
    activeVideoTrack,
    activeAudioTrack,
    effectiveVideoDevices,
    effectiveAudioInputDevices,
  };
}
