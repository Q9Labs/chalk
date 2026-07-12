import type { MediaPlaneAdapter } from "../media/media-plane-port";
import type { NativeTelemetry } from "../telemetry";
import type { ChalkSession, IncidentConfig } from "../internal/core";

export interface NativeProviderSessionSnapshot<TMeeting> {
  readonly isConnected: boolean;
  readonly meeting: TMeeting | undefined;
}

export interface NativeProviderSessionSubscription {
  readonly incident: IncidentConfig | undefined;
  readonly roomId: string | undefined;
  readonly userName: string | undefined;
}

export class NativeProviderSessionStore<TMeeting> {
  readonly #adapter: MediaPlaneAdapter<TMeeting>;
  readonly #loader: ReturnType<MediaPlaneAdapter<TMeeting>["createLoader"]>;
  readonly #session: ChalkSession;
  readonly #telemetry: NativeTelemetry | undefined;
  #disposeGeneration = 0;
  #disposed = false;
  #snapshot: NativeProviderSessionSnapshot<TMeeting>;

  constructor(session: ChalkSession, adapter: MediaPlaneAdapter<TMeeting>, loader: ReturnType<MediaPlaneAdapter<TMeeting>["createLoader"]>, telemetry: NativeTelemetry | undefined) {
    this.#session = session;
    this.#adapter = adapter;
    this.#loader = loader;
    this.#telemetry = telemetry;

    const room = session.room.getRoom();
    this.#snapshot = {
      isConnected: room?.status === "connected",
      meeting: room?.status === "connected" ? adapter.extractMeeting(room) : undefined,
    };
  }

  readonly getSnapshot = (): NativeProviderSessionSnapshot<TMeeting> => this.#snapshot;

  readonly subscribe = (listener: () => void, subscription: NativeProviderSessionSubscription): (() => void) => {
    this.#disposeGeneration += 1;
    const generation = this.#disposeGeneration;
    let active = true;

    this.#session.configureIncident(subscription.incident);
    void this.#session.preloadRealtimeKit().catch((error) => {
      if (active) console.warn(`Failed to preload ${this.#adapter.provider} native runtime`, error);
    });

    const unsubscribeConnected = this.#session.on("connected", () => {
      this.#telemetry?.recordSyncFrame({ direction: "server_to_client", frameType: "transport.connected" });
      const nextMeeting = this.#adapter.extractMeeting(this.#session.room.getRoom());
      this.#update(
        {
          isConnected: true,
          meeting: this.#adapter.resolveMeeting({ currentMeeting: this.#snapshot.meeting, nextMeeting, reason: "connected" }),
        },
        listener,
      );
    });

    const unsubscribeDisconnected = this.#session.on("disconnected", () => {
      this.#telemetry?.recordSyncFrame({ direction: "server_to_client", frameType: "transport.disconnected" });
      this.#update(
        {
          isConnected: false,
          meeting: this.#adapter.resolveMeeting({ currentMeeting: this.#snapshot.meeting, nextMeeting: undefined, reason: "disconnected" }),
        },
        listener,
      );
      this.#autoJoin(subscription);
    });

    const room = this.#session.room.getRoom();
    if (room?.status === "connected") {
      this.#update({ isConnected: true, meeting: this.#adapter.extractMeeting(room) }, listener);
    } else this.#autoJoin(subscription);

    return () => {
      active = false;
      unsubscribeConnected();
      unsubscribeDisconnected();

      queueMicrotask(() => {
        if (generation !== this.#disposeGeneration || this.#disposed) return;
        this.#disposed = true;
        this.#loader.dispose?.();
        this.#session.dispose();
      });
    };
  };

  #update(snapshot: NativeProviderSessionSnapshot<TMeeting>, listener: () => void): void {
    if (snapshot.isConnected === this.#snapshot.isConnected && snapshot.meeting === this.#snapshot.meeting) return;
    this.#snapshot = snapshot;
    listener();
  }

  #autoJoin(subscription: NativeProviderSessionSubscription): void {
    if (!subscription.roomId || !subscription.userName) return;
    void this.#session.join(subscription.roomId, { userName: subscription.userName }).catch(() => {
      // Auto-join failure is surfaced by the consuming UI through session state.
    });
  }
}
