// fallow-ignore-file unused-file -- throwaway spike entrypoints are run directly, not through the workspace graph.
// fallow-ignore-file complexity -- throwaway measurement harness; the spike report records results rather than productionizing branching.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export async function loadAdapter(name) {
  if (name === "roam") return roamAdapter();
  if (name === "werift") return weriftAdapter();
  throw new Error(`unknown WebRTC library ${name}`);
}

async function roamAdapter() {
  const wrtc = require("@roamhq/wrtc");
  return {
    name: "@roamhq/wrtc",
    MediaStream: wrtc.MediaStream,
    peerConnectionFactory: (configuration) => new wrtc.RTCPeerConnection(configuration),
    createMicrophone() {
      const source = new wrtc.nonstandard.RTCAudioSource();
      const track = source.createTrack();
      return {
        track,
        writePcm(frame) {
          source.onData({ samples: frame.samples, sampleRate: frame.sampleRate, bitsPerSample: 16, channelCount: frame.channelCount, numberOfFrames: frame.samples.length / frame.channelCount });
        },
        stop() {
          track.stop();
        },
      };
    },
    attachAudioSink(track, onFrame) {
      const sink = new wrtc.nonstandard.RTCAudioSink(track);
      sink.ondata = (frame) => {
        if (!frame?.samples) return;
        onFrame({ samples: new Int16Array(frame.samples), sampleRate: frame.sampleRate ?? 48000, channelCount: frame.channelCount ?? 1, numberOfFrames: frame.numberOfFrames ?? frame.samples.length });
      };
      return () => sink.stop();
    },
  };
}

async function weriftAdapter() {
  const werift = await import("werift");
  const { OpusEncoder } = require("@discordjs/opus");
  const encoder = new OpusEncoder(48000, 1);
  const decoder = new OpusEncoder(48000, 1);
  return {
    name: "werift",
    MediaStream: werift.MediaStream,
    peerConnectionFactory: (configuration) => {
      const connection = new werift.RTCPeerConnection({ ...configuration, iceCandidatePoolSize: 0 });
      if (process.env.SPIKE_DEBUG_WERIFT !== "1") return connection;
      return new Proxy(connection, { get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args) => {
          try {
            const result = value.apply(target, args);
            if (result?.then) return result.catch((error) => { console.error(`werift ${String(property)} rejected`, error); throw error; });
            return result;
          } catch (error) { console.error(`werift ${String(property)} threw`, error); throw error; }
        };
      } });
    },
    createMicrophone() {
      const track = new werift.MediaStreamTrack({ kind: "audio" });
      let sequenceNumber = Math.floor(Math.random() * 0xffff);
      let timestamp = Math.floor(Math.random() * 0xffffffff) >>> 0;
      const ssrc = Math.floor(Math.random() * 0xffffffff) >>> 0;
      return {
        track,
        writePcm(frame) {
          const pcm = Buffer.from(frame.samples.buffer, frame.samples.byteOffset, frame.samples.byteLength);
          const encoded = encoder.encode(pcm);
          const packet = new werift.RtpPacket(
            new werift.RtpHeader({ version: 2, payloadType: 111, sequenceNumber, timestamp, ssrc, marker: false }),
            encoded,
          );
          track.writeRtp(packet);
          sequenceNumber = (sequenceNumber + 1) & 0xffff;
          timestamp = (timestamp + 480) >>> 0;
        },
        stop() {
          track.stop();
        },
      };
    },
    attachAudioSink(track, onFrame) {
      const dispose = track.onReceiveRtp.subscribe((packet, _extensions, info) => {
        if (info?.type && info.type !== "media") return;
        try {
          const decoded = decoder.decode(Buffer.from(packet.payload));
          const samples = new Int16Array(decoded.buffer, decoded.byteOffset, decoded.byteLength / 2);
          onFrame({ samples: new Int16Array(samples), sampleRate: 48000, channelCount: 1, numberOfFrames: samples.length });
        } catch {
          // Opus loss/concealment is not a valid speech frame for this spike; skip it.
        }
      });
      return () => (typeof dispose === "function" ? dispose() : dispose?.unsubscribe?.());
    },
  };
}
