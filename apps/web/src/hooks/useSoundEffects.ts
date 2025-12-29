import { useChalk } from "@q9labs/chalk-react";
import { useEffect, useRef } from "react";

export function useSoundEffects() {
  const { room } = useChalk();
  const audioContextRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    if (!room) return;

    const playTone = (freq: number, type: OscillatorType, duration: number) => {
      try {
        if (!audioContextRef.current) {
          audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
        }
        
        const ctx = audioContextRef.current;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = type;
        osc.frequency.setValueAtTime(freq, ctx.currentTime);
        
        gain.gain.setValueAtTime(0.1, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start();
        osc.stop(ctx.currentTime + duration);
      } catch (e) {
      }
    };

    const onJoin = () => playTone(600, "sine", 0.3);
    const onLeave = () => playTone(400, "sine", 0.3);
    const onMessage = (msg: any) => {
      if (msg.senderId !== room.localParticipant?.id) {
        playTone(800, "sine", 0.1);
      }
    };
    const onRaiseHand = () => playTone(1000, "sine", 0.2);

    const unsubJoin = room.on("participant-joined", onJoin);
    const unsubLeave = room.on("participant-left", onLeave);
    const unsubChat = room.on("chat-message", onMessage);
    const unsubHand = room.on("hand-raised", onRaiseHand);

    return () => {
      unsubJoin();
      unsubLeave();
      unsubChat();
      unsubHand();
    };
  }, [room]);
}
