import { expect, it, vi } from "vitest";
import { CloudflareSFUError } from "./cloudflare-sfu";
import { bootstrap, createSfuHarness, FakeTrack, fakeStream, type HarnessOptions } from "./cloudflare-sfu.test.helpers";

type Harness = ReturnType<typeof createHarness>;
function createHarness(options: HarnessOptions = {}) {
  return createSfuHarness(options, (autoConnect) => new FakePeerConnection(autoConnect));
}
class FakePeerConnection extends EventTarget {
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
  /** Chrome drops the whole transport when an offer rejects the m-section that owns the BUNDLE group (the first one). */
  dropsTransportWhenTagRejected = false;
  transportDropped = false;
  /** The direction each remote section was answered with, by mid; an offer that turns a section on needs a receiving transceiver. */
  readonly answerDirections: Record<string, string> = {};
  #lastOffer = "";
  /** A pull on a mid that already has a transceiver lands on that transceiver and its track, as in a browser. */
  reusesMids = false;
  // A browser fires no track event when a reused mid still receives the same stream.
  firesTrackOnReuse = true;
  /** Every m-section in the order the browser added it, local and remote, so the BUNDLE group has a real tag. */
  readonly #sectionMids: string[] = [];
  #bundleTag: string | undefined;
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
      direction: init.direction ?? "sendrecv",
      sender,
      receiver: { track: new FakeTrack("unused-receiver", track.kind) },
      stop: () => {
        if (this.throwOnCleanup) throw new Error("transceiver stop failed");
        transceiver.direction = "stopped" as RTCRtpTransceiverDirection;
        this.#activeTransceivers.delete(transceiver);
      },
    } as unknown as RTCRtpTransceiver;
    this.#sectionMids.push(transceiver.mid!);
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
    // Chrome cannot offer once every section is stopped: the BUNDLE group is gone with them.
    const sections = this.getTransceivers();
    if (sections.length > 0 && sections.every((section) => (section.direction as string) === "stopped")) throw new DOMException("max-bundle configured but session description has no BUNDLE group.", "OperationError");
    if (this.refuseSimulcastOffer && this.getSenders().some((sender) => sender.track && sender.getParameters().encodings.length > 1)) throw new DOMException("Simulcast unsupported", "NotSupportedError");
    return { type: "offer", sdp: `v=0\r\na=group:BUNDLE ${this.#sectionMids.join(" ")}\r\n` };
  }
  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    for (const section of this.#lastOffer.split(/\r?\n(?=m=)/)) {
      const mid = /\r?\na=mid:(\S+)/.exec(section)?.[1];
      const transceiver = this.getTransceivers().find((item) => item.mid === mid);
      if (!mid || !transceiver) continue;
      const offeredOn = !/\r?\na=(?:recvonly|inactive)\b/.test(section);
      this.answerDirections[mid] = offeredOn && transceiver.direction === "recvonly" ? "recvonly" : "inactive";
      const received = transceiver.receiver?.track as unknown as FakeTrack | undefined;
      if (received) received.muted = this.answerDirections[mid] === "inactive";
    }
    return { type: "answer", sdp: `v=0\r\na=group:BUNDLE ${this.#sectionMids.join(" ")}\r\n` };
  }
  availableOutgoingBitrate: number | undefined;
  refuseSenderParameters = false;
  receiveDTX = false;
  readonly #receivers = new Map<string, RTCRtpReceiver>();
  readonly #remoteTransceivers: RTCRtpTransceiver[] = [];
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
      this.#bundleTag ??= this.#sectionMids[0];
      const tag = this.getTransceivers().find((transceiver) => transceiver.mid === this.#bundleTag);
      if (this.dropsTransportWhenTagRejected && (tag?.direction as string | undefined) === "stopped") {
        this.transportDropped = true;
        this.setStates("new", "new");
      }
    } else if (description?.type === "answer") {
      this.signalingState = "stable";
    }
  }
  async setRemoteDescription(description?: RTCSessionDescriptionInit): Promise<void> {
    this.descriptionLog.push(`setRemote:${description?.type}`);
    if (description?.type === "offer" && this.signalingState === "have-local-offer") throw new DOMException("Called in wrong state: have-local-offer", "InvalidStateError");
    this.signalingState = description?.type === "offer" ? "have-remote-offer" : "stable";
    if (description?.type === "offer") this.#lastOffer = description.sdp ?? "";
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
  emitTrack(mid: string, track: FakeTrack): void {
    const reused = this.reusesMids ? this.#remoteTransceivers.find((transceiver) => transceiver.mid === mid) : undefined;
    const ownInactive = this.reusesMids && !reused ? this.#transceivers.find((transceiver) => transceiver.mid === mid && transceiver.direction === "inactive") : undefined;
    if (ownInactive) {
      // The SFU reused the mid of this guest's own closed sender for a pull: the browser fires a track event on that transceiver.
      const event = new Event("track");
      Object.defineProperties(event, { track: { value: track as unknown as MediaStreamTrack }, transceiver: { value: ownInactive } });
      this.dispatchEvent(event);
      return;
    }
    if (reused) {
      // The SFU reused this mid: the browser fires the track event on the existing transceiver with its existing track.
      if (!this.firesTrackOnReuse) return;
      const event = new Event("track");
      Object.defineProperties(event, { track: { value: reused.receiver.track }, transceiver: { value: reused } });
      this.dispatchEvent(event);
      return;
    }
    this.#receivers.set(mid, { track, getParameters: () => ({ codecs: [{ mimeType: "audio/opus", sdpFmtpLine: this.receiveDTX ? "useinbandfec=1;usedtx=1" : "useinbandfec=1" }] }) } as unknown as RTCRtpReceiver);
    this.#sectionMids.push(mid);
    const transceiver = {
      mid,
      direction: "recvonly",
      receiver: this.#receivers.get(mid),
      stop: () => {
        transceiver.direction = "stopped";
        track.stop();
      },
    };
    this.#remoteTransceivers.push(transceiver as unknown as RTCRtpTransceiver);
    const event = new Event("track");
    Object.defineProperties(event, {
      track: { value: track as unknown as MediaStreamTrack },
      transceiver: { value: { mid } },
    });
    this.dispatchEvent(event);
  }
}

const GONE = () => new CloudflareSFUError("Chalk SFU signaling failed with HTTP 404", "signaling_failed", { status: 404, retryableConnection: true });

async function startScreen(h: Harness): Promise<void> {
  h.client.prepareLocalTrack("screen", new FakeTrack("screen", "video") as unknown as MediaStreamTrack);
  await expect(h.client.setLocalPublicationTarget({ operationId: "screen-start", participantId: "participant-1", source: "screen", enabled: true })).resolves.toEqual({ outcome: "confirmed", errorCode: null });
}

it("stops a screen share whose media session the SFU has already removed", async () => {
  const h = createHarness({ replaceMediaConnection: async () => bootstrap("connection-2") });
  await h.client.start(fakeStream());
  await startScreen(h);
  vi.spyOn(h.transport, "closeTracks").mockRejectedValue(GONE());
  await expect(h.client.setLocalPublicationTarget({ operationId: "screen-stop", participantId: "participant-1", source: "screen", enabled: false })).resolves.toMatchObject({ outcome: "confirmed" });
  expect(h.client.getSnapshot().localTracks.find((track) => track.source === "screen")?.enabled ?? false).toBe(false);
});

it("stops sharing through the forced close and the Sync target when the SFU session is gone, then shares again", async () => {
  let replacements = 1;
  const h = createHarness({ replaceMediaConnection: async () => bootstrap(`connection-${++replacements}`) });
  await h.client.start(fakeStream());
  await startScreen(h);
  const close = vi.spyOn(h.transport, "closeTracks").mockRejectedValue(GONE());
  await h.client.closeForcedLocalPublication("screen", "user_pause");
  await expect(h.client.setLocalPublicationTarget({ operationId: "screen-stop", participantId: "participant-1", source: "screen", enabled: false })).resolves.toMatchObject({ outcome: "satisfied" });
  close.mockRestore();
  await h.client.clearPreparedLocalTrack("screen");
  h.client.prepareLocalTrack("screen", new FakeTrack("screen-2", "video") as unknown as MediaStreamTrack);
  await h.client.setLocalSourceIntent("screen", true);
  await expect(h.client.setLocalPublicationTarget({ operationId: "screen-again", participantId: "participant-1", source: "screen", enabled: true })).resolves.toEqual({ outcome: "confirmed", errorCode: null });
  expect(h.client.getSnapshot().localTracks.find((track) => track.source === "screen")).toMatchObject({ enabled: true });
});

/** The calls the media controller makes when the user stops a screen share: the pause starts first and the local stop starts while it is in flight. */
async function stopScreenAsTheController(h: Harness): Promise<void> {
  void h.client.setLocalSourceIntent("screen", false, "user_pause").catch(() => undefined);
  const pause = h.client.closeForcedLocalPublication("screen", "user_pause");
  const localStop = h.client.clearPreparedLocalTrack("screen");
  await expect(pause).resolves.toBeUndefined();
  await expect(localStop).resolves.toBeUndefined();
  await expect(h.client.setLocalPublicationTarget({ operationId: "screen-stop", participantId: "participant-1", source: "screen", enabled: false })).resolves.toMatchObject({ outcome: expect.stringMatching(/^(confirmed|satisfied)$/) });
}

async function shareAgain(h: Harness): Promise<void> {
  h.client.prepareLocalTrack("screen", new FakeTrack("screen-2", "video") as unknown as MediaStreamTrack);
  await h.client.setLocalSourceIntent("screen", true);
  await expect(h.client.setLocalPublicationTarget({ operationId: "screen-again", participantId: "participant-1", source: "screen", enabled: true })).resolves.toEqual({ outcome: "confirmed", errorCode: null });
  expect(h.client.getSnapshot().localTracks.find((track) => track.source === "screen")).toMatchObject({ enabled: true });
}

it("stops a screen share that is the only section and so carries the BUNDLE tag, then shares again", async () => {
  let replacements = 1;
  const h = createHarness({ replaceMediaConnection: async () => bootstrap(`connection-${++replacements}`) });
  await h.client.start(fakeStream());
  await startScreen(h);
  const close = vi.spyOn(h.transport, "closeTracks");
  await stopScreenAsTheController(h);
  expect(close).toHaveBeenCalledWith(expect.objectContaining({ force: true, sessionDescription: undefined }));
  await shareAgain(h);
  await stopScreenAsTheController(h);
  await shareAgain(h);
});

it("stops sharing when the SFU answers every close call with 404, then shares again", async () => {
  let replacements = 1;
  const h = createHarness({ replaceMediaConnection: async () => bootstrap(`connection-${++replacements}`) });
  await h.client.start(fakeStream(new FakeTrack("microphone", "audio")));
  await startScreen(h);
  const close = vi.spyOn(h.transport, "closeTracks").mockRejectedValue(GONE());
  await stopScreenAsTheController(h);
  close.mockRestore();
  await shareAgain(h);
});
