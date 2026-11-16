import { readFileSync } from "node:fs";
import { expect, vi } from "vitest";
import type { CloudflareSFUPublicationSnapshot } from "./cloudflare-sfu";
import { createSfuHarness, FakeTrack as FakeTrackImpl, fakeStream, versionedPublicationID, type HarnessOptions } from "./cloudflare-sfu.test.helpers";
export { bootstrap, failAddTracks, FakeTrack, fakeStream, publicationSnapshot, receiverExpired, versionedPublicationID } from "./cloudflare-sfu.test.helpers";

const parkedAudioSection = readFileSync(new URL("./fixtures/chromium-offer-with-parked-receivers.sdp", import.meta.url), "utf8")
  .split(/(?=^m=)/m)
  .find((section) => /^m=audio /.test(section))!;

// A closed audio receive section as Chromium writes it into every later offer (a real offer, identifiers removed).
const closedAudioSection = readFileSync(new URL("./fixtures/chromium-offer-with-closed-sections.sdp", import.meta.url), "utf8")
  .split(/(?=^m=)/m)
  .find((section) => /^m=audio 0 /.test(section))!;

export type Harness = ReturnType<typeof createHarness>;

function createHarness(options: HarnessOptions = {}) {
  return createSfuHarness(options, (autoConnect) => new FakePeerConnection(autoConnect));
}

export class FakePeerConnection extends EventTarget {
  readonly bornAt = Date.now();
  localDescription: RTCSessionDescriptionInit | null = null;
  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  signalingState: RTCSignalingState = "stable";
  closed = false;
  rollbackCalls = 0;
  throwOnCleanup = false;
  readonly transceiverInits: RTCRtpTransceiverInit[] = [];
  refuseSimulcast = false;
  refuseSimulcastOffer = false;
  readonly #activeTransceivers = new Set<RTCRtpTransceiver>();
  readonly #autoConnect: boolean;
  readonly #transceivers: RTCRtpTransceiver[] = [];
  #nextRemoteDescriptionStates: {
    readonly connection: RTCPeerConnectionState;
    readonly ice: RTCIceConnectionState;
  } | null = null;
  constructor(autoConnect: boolean) {
    super();
    this.#autoConnect = autoConnect;
  }
  addTransceiver(track: MediaStreamTrack, init: RTCRtpTransceiverInit = {}): RTCRtpTransceiver {
    this.transceiverInits.push(init);
    if (this.refuseSimulcast && init.sendEncodings) throw new DOMException("Simulcast unsupported", "NotSupportedError");
    let senderTrack: MediaStreamTrack | null = track;
    let parameters: Pick<RTCRtpSendParameters, "encodings" | "degradationPreference"> = { encodings: init.sendEncodings ?? [{}] };
    const sender = {
      getParameters: () => ({ ...parameters, encodings: parameters.encodings.map((encoding) => ({ ...encoding })) }),
      setParameters: async (next: RTCRtpSendParameters) => {
        if (this.refuseSenderParameters) throw new DOMException("Sender controls unsupported", "NotSupportedError");
        parameters = { ...next, encodings: next.encodings.map((encoding) => ({ ...encoding })) };
      },
      get track() {
        return senderTrack;
      },
      replaceTrack: async (replacement: MediaStreamTrack | null) => {
        senderTrack = replacement;
      },
    } as RTCRtpSender;
    let transceiver: RTCRtpTransceiver;
    transceiver = {
      mid: String(this.#transceivers.length),
      sender,
      receiver: { track: new FakeTrackImpl("unused-receiver", track.kind) },
      stop: () => {
        if (this.throwOnCleanup) throw new Error("transceiver stop failed");
        this.#activeTransceivers.delete(transceiver);
      },
    } as unknown as RTCRtpTransceiver;
    this.#transceivers.push(transceiver);
    this.#activeTransceivers.add(transceiver);
    return transceiver;
  }
  activeTransceiverCount(): number {
    return this.#activeTransceivers.size;
  }
  readonly offerOptions: (RTCOfferOptions | undefined)[] = [];
  async createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
    this.offerOptions.push(options);
    if (this.refuseSimulcastOffer && this.getSenders().some((sender) => sender.track && sender.getParameters().encodings.length > 1)) throw new DOMException("Simulcast unsupported", "NotSupportedError");
    return {
      type: "offer",
      sdp: `v=0\r\na=group:BUNDLE ${this.#transceivers.map((transceiver) => transceiver.mid).join(" ")}\r\n${closedAudioSection.repeat(this.#stoppedRemoteMids.size)}${parkedAudioSection.repeat(this.#remoteTransceivers.filter((transceiver) => transceiver.direction === "inactive" && !this.#stoppedRemoteMids.has(transceiver.mid ?? "")).length)}`,
    };
  }
  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: `v=0\r\na=group:BUNDLE ${this.#transceivers.map((transceiver) => transceiver.mid).join(" ")}\r\n` };
  }
  availableOutgoingBitrate: number | undefined;
  refuseSenderParameters = false;
  receiveDTX = false;
  readonly #receivers = new Map<string, RTCRtpReceiver>();
  readonly #remoteTransceivers: RTCRtpTransceiver[] = [];
  readonly #stoppedRemoteMids = new Set<string>();
  /** The receive m-lines still receiving in the session: a closed receiver is parked inactive and never stopped. */
  liveRemoteTransceiverCount(): number {
    return this.#remoteTransceivers.filter((transceiver) => transceiver.direction !== "inactive" && !this.#stoppedRemoteMids.has(transceiver.mid ?? "")).length;
  }
  getReceivers(): RTCRtpReceiver[] {
    return [...this.#receivers.values()];
  }
  getStats(): Promise<RTCStatsReport> {
    const stat: RTCStats = { id: "candidate-pair", timestamp: 0, type: "candidate-pair" };
    Object.assign(stat, { selected: true, state: "succeeded", availableOutgoingBitrate: this.availableOutgoingBitrate });
    const stats = new Map<string, RTCStats>([["candidate-pair", stat]]);
    return Promise.resolve(stats);
  }
  readonly descriptionLog: string[] = [];
  async setLocalDescription(description?: RTCSessionDescriptionInit): Promise<void> {
    this.descriptionLog.push(`setLocal:${description?.type}`);
    this.localDescription = description ?? null;
    if (description?.type === "rollback") {
      this.rollbackCalls++;
      this.signalingState = "stable";
    } else if (description?.type === "offer") {
      this.signalingState = "have-local-offer";
    } else if (description?.type === "answer") {
      this.signalingState = "stable";
    }
  }
  async setRemoteDescription(description?: RTCSessionDescriptionInit): Promise<void> {
    this.descriptionLog.push(`setRemote:${description?.type}`);
    if (description?.type === "offer" && this.signalingState === "have-local-offer") throw new DOMException("Called in wrong state: have-local-offer", "InvalidStateError");
    this.signalingState = description?.type === "offer" ? "have-remote-offer" : "stable";
    if (this.#nextRemoteDescriptionStates) {
      const next = this.#nextRemoteDescriptionStates;
      this.#nextRemoteDescriptionStates = null;
      this.setStates(next.connection, next.ice);
    } else if (this.#autoConnect && this.connectionState === "new") {
      this.setStates("connected", "connected");
    }
  }
  getSenders(): RTCRtpSender[] {
    return this.#transceivers.map((transceiver) => transceiver.sender);
  }
  getTransceivers(): RTCRtpTransceiver[] {
    return [...this.#transceivers, ...this.#remoteTransceivers];
  }
  close(): void {
    this.closed = true;
    this.connectionState = "closed";
    if (this.throwOnCleanup) throw new Error("peer close failed");
  }
  setStates(connectionState: RTCPeerConnectionState, iceConnectionState: RTCIceConnectionState): void {
    this.connectionState = connectionState;
    this.iceConnectionState = iceConnectionState;
    this.dispatchEvent(new Event("connectionstatechange"));
    this.dispatchEvent(new Event("iceconnectionstatechange"));
  }
  setNextRemoteDescriptionStates(connection: RTCPeerConnectionState, ice: RTCIceConnectionState): void {
    this.#nextRemoteDescriptionStates = { connection, ice };
  }
  emitTrack(mid: string, track: FakeTrackImpl): void {
    this.#receivers.set(mid, { track, getParameters: () => ({ codecs: [{ mimeType: "audio/opus", sdpFmtpLine: this.receiveDTX ? "useinbandfec=1;usedtx=1" : "useinbandfec=1" }] }) } as unknown as RTCRtpReceiver);
    this.#remoteTransceivers.push({
      mid,
      receiver: this.#receivers.get(mid),
      stop: () => {
        track.stop();
        this.#stoppedRemoteMids.add(mid);
      },
    } as unknown as RTCRtpTransceiver);
    const event = new Event("track");
    Object.defineProperties(event, {
      track: { value: track as unknown as MediaStreamTrack },
      transceiver: { value: { mid } },
    });
    this.dispatchEvent(event);
  }
}

export async function withTimedHarness(exercise: (harness: Harness) => Promise<void>, options: HarnessOptions = {}): Promise<void> {
  vi.useFakeTimers();
  await exercise(createHarness(options));
}

export const micOn = { operationId: "mic-on", participantId: "participant-1", source: "microphone" as const, enabled: true };
export const mute = (h: Harness) => h.client.closeForcedLocalPublication("microphone", "user_pause");
export async function publishMicrophone(h: Harness): Promise<void> {
  await h.client.start(fakeStream());
  h.client.prepareLocalTrack("microphone", new FakeTrackImpl("local-microphone", "audio") as unknown as MediaStreamTrack);
  await expect(h.client.setLocalPublicationTarget(micOn)).resolves.toEqual({ outcome: "confirmed", errorCode: null });
}
export function remoteMicrophoneRoster(sequence: number, trackName?: string): CloudflareSFUPublicationSnapshot {
  const publications = trackName ? [{ participantId: "participant-2", source: "microphone" as const, publicationId: versionedPublicationID("remote-1", "0", trackName) }] : [];
  return { incarnation: 1, sequence, publications };
}
