import { readFile, unlink } from "node:fs/promises";
import { command } from "./runtime.mjs";

const spokenWords = "The purple lantern shines beside the quiet river. We are testing camera, screen sharing, recording, export, and transcription.";
// One phrase per guest, spoken in the guest's own slot of a repeating three-slot cycle (call-script.mjs), so the call has no overlapping speech to transcribe.
const turnPhrases = ["The purple lantern shines beside the quiet river.", "Seven copper kettles are boiling on the mountain.", "A green falcon crosses the silver harbor at dawn."];
async function synthesize(directory, signal, name, words) {
  const target = `${directory}/${name}.wav`;
  if (process.platform === "darwin") {
    const source = `${directory}/${name}.aiff`;
    await command("say", ["-v", "Samantha", "-r", "145", "-o", source, words], { signal });
    await command("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", source, "-ar", "48000", "-ac", "1", target], { signal });
    await unlink(source);
  } else {
    await command("espeak", ["-s", "145", "-w", target, words], { signal });
  }
  return target;
}
export async function generateVoice(directory, signal) {
  return (await readFile(await synthesize(directory, signal, "voice", spokenWords))).toString("base64");
}
// One recording per guest: just its phrase. The page schedules every repetition, so all guests share one clock (see installFixture).
export async function generateTurnVoices(directory, signal) {
  const phrases = await Promise.all(turnPhrases.map((words, guest) => synthesize(directory, signal, `turn-${guest + 1}`, words)));
  const phraseSeconds = await Promise.all(phrases.map(async (target) => Number((await command("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", target], { signal })).trim())));
  return { voices: await Promise.all(phrases.map(async (target) => (await readFile(target)).toString("base64"))), phraseSeconds };
}

// Browser-side generator: animated, distinguishable camera; repeatable spoken audio.
export function installFixture({ speech, guest, tones = false, voiceGain, turns = false, camera: size = { width: 1280, height: 720 } }) {
  const NativePC = window.RTCPeerConnection;
  window.proofConnections = [];
  window.RTCPeerConnection = class extends NativePC {
    constructor(...args) {
      super(...args);
      window.proofConnections.push(this);
    }
    addTransceiver(track, options) {
      if (track instanceof MediaStreamTrack && track.kind === "video" && track.id === window.proofCameraId) {
        return super.addTransceiver(track, {
          ...options,
          sendEncodings: [
            { rid: "q", scaleResolutionDownBy: 4, maxBitrate: 120_000 },
            { rid: "h", scaleResolutionDownBy: 2, maxBitrate: 450_000 },
            { rid: "f", scaleResolutionDownBy: 1, maxBitrate: 1_500_000 },
          ],
        });
      }
      return super.addTransceiver(track, options);
    }
  };
  const nativeCapture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  function cameraTrack() {
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    let frame = 0;
    const backgrounds = { before: ["#1b365d", "#613c69", "#5d2a1b"], after: ["#185d45", "#69461d", "#5d1b45"] };
    window.proofCameraTimer = setInterval(() => {
      const clock = window.proofAudio?.context.currentTime ?? 0;
      if ((window.proofFlashes ?? []).some((start) => clock >= start && clock < start + window.proofFlashSeconds)) {
        // The A/V marker: the whole picture goes white while this guest's marker tone sounds.
        context.fillStyle = "white";
        context.fillRect(0, 0, size.width, size.height);
        return;
      }
      context.fillStyle = backgrounds[window.proofPhase ?? "before"][guest % 3];
      context.fillRect(0, 0, size.width, size.height);
      context.fillStyle = "white";
      context.font = "64px sans-serif";
      context.fillText(`Proof guest ${guest + 1}`, 60, 100);
      context.fillText(`${window.proofPhase ?? "before"}: Frame ${frame++}`, 60, 200);
      for (let n = 0; n < 30; n++) {
        context.fillStyle = `hsl(${(frame * 7 + n * 12) % 360} 70% 60%)`;
        context.fillRect((frame * 11 + n * 61) % size.width, 250 + (n % 5) * 80, 70, 60);
      }
    }, 1000 / 15);
    const camera = canvas.captureStream(15).getVideoTracks()[0];
    window.proofCameraId = camera.id;
    return camera;
  }
  function toneTrack(context) {
    const source = context.createOscillator();
    source.frequency.value = 440 * (guest + 1);
    const gain = context.createGain();
    gain.gain.value = 0.15;
    const destination = context.createMediaStreamDestination();
    source.connect(gain);
    gain.connect(destination);
    source.start();
    window.proofAudio = { context, source, destination };
    return destination.stream.getAudioTracks()[0].clone();
  }
  async function toneVoiceTrack() {
    if (!window.proofAudio) {
      const context = new AudioContext();
      await context.resume();
      return toneTrack(context);
    }
    return window.proofAudio.destination.stream.getAudioTracks()[0].clone();
  }
  const audioTrack = tones ? toneVoiceTrack : turns ? turnTrack : voiceTrack;
  // Silent until proofStartTurns: the guest publishes its microphone before the scripted call begins.
  async function turnTrack() {
    if (!window.proofAudio) {
      const context = new AudioContext();
      await context.resume();
      const bytes = Uint8Array.from(atob(speech), (character) => character.charCodeAt(0));
      const phrase = await context.decodeAudioData(bytes.buffer);
      const destination = context.createMediaStreamDestination();
      window.proofAudio = { context, phrase, destination };
      const tone = (hz, level) => {
        const oscillator = context.createOscillator();
        oscillator.frequency.value = hz;
        const gain = context.createGain();
        gain.gain.value = level;
        oscillator.connect(gain);
        gain.connect(destination);
        return oscillator;
      };
      // Schedules every marker and phrase of one round on this page's audio clock, anchored on the shared wall-clock start.
      window.proofStartTurns = ({ loopStartMs, slotSeconds, cycleSeconds, cycles, markerHz, markerSeconds, phraseDelaySeconds, flashSeconds }) => {
        const wallNow = Date.now();
        const loopStart = context.currentTime + (loopStartMs - wallNow) / 1000;
        const markers = Array.from({ length: cycles }, (_, cycle) => loopStart + guest * slotSeconds + cycle * cycleSeconds);
        for (const marker of markers) {
          const oscillator = tone(markerHz[guest], 0.3);
          oscillator.start(marker);
          oscillator.stop(marker + markerSeconds);
          const source = context.createBufferSource();
          source.buffer = phrase;
          const voice = context.createGain();
          voice.gain.value = voiceGain ?? 0.8;
          source.connect(voice);
          voice.connect(destination);
          source.start(marker + phraseDelaySeconds);
        }
        window.proofFlashSeconds = flashSeconds;
        window.proofFlashes = [...(window.proofFlashes ?? []), ...markers];
        // The wall-clock instant at which the loop begins on this page; the proof logs it per guest.
        return { loopStartMs: Date.now() + (loopStart - context.currentTime) * 1000, lateByMs: Math.max(0, wallNow - loopStartMs), contextState: context.state };
      };
      // A continuous tone for the mute and stop checks.
      window.proofHoldTone = (hz) => {
        const oscillator = tone(hz, 0.2);
        oscillator.start();
        window.proofHoldStop = () => oscillator.stop();
        return Date.now();
      };
    }
    return window.proofAudio.destination.stream.getAudioTracks()[0].clone();
  }
  async function voiceTrack() {
    if (!window.proofAudio) {
      const context = new AudioContext();
      await context.resume();
      const bytes = Uint8Array.from(atob(speech), (character) => character.charCodeAt(0));
      const buffer = await context.decodeAudioData(bytes.buffer);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      const gain = context.createGain();
      gain.gain.value = voiceGain ?? (guest === 0 ? 0.8 : 0.08);
      const destination = context.createMediaStreamDestination();
      source.connect(gain);
      gain.connect(destination);
      source.start();
      window.proofAudio = { context, source, destination };
    }
    return window.proofAudio.destination.stream.getAudioTracks()[0].clone();
  }
  function replaceTracks(stream, tracks, generated) {
    for (const track of tracks) {
      stream.removeTrack(track);
      track.stop();
    }
    stream.addTrack(generated);
  }
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const stream = await nativeCapture(constraints);
    if (constraints.video) replaceTracks(stream, stream.getVideoTracks(), cameraTrack());
    if (constraints.audio) replaceTracks(stream, stream.getAudioTracks(), await audioTrack());
    return stream;
  };
}

// With ?audio=HZ the page also plays that tone, so a shared tab carries screen audio.
export const shareHTML = `<!doctype html><title>Chalk proof screen share</title><canvas width="1920" height="1080"></canvas><script>
const hz=Number(new URLSearchParams(location.search).get('audio'));
if(hz){const a=new AudioContext(),o=a.createOscillator(),g=a.createGain();o.frequency.value=hz;g.gain.value=0.2;o.connect(g);g.connect(a.destination);o.start();a.resume()}
const c=document.querySelector('canvas').getContext('2d');let n=0;
setInterval(()=>{c.fillStyle='#102a43';c.fillRect(0,0,1920,1080);c.fillStyle='#ffffff';c.font='80px sans-serif';c.fillText('Synthetic screen share',80,160);c.fillText('Frame '+n++,80,320);c.fillStyle='#22c55e';c.fillRect((n*20)%1600,500,200,200)},1000/15);
</script>`;
