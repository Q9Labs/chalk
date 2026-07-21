import { parseParticipantAccess } from "./access";
import type { ParticipantAccess, ParticipantMediaCredential, ParticipantSyncCredential } from "./access";
import type { ChalkSessionAccessProvider, ChalkSessionAccessReason } from "./dependencies";

const DEFAULT_REFRESH_WINDOW_MS = 60_000;

export class ChalkSessionAccessManager {
  readonly #now: () => number;
  readonly #provider: ChalkSessionAccessProvider;
  readonly #refreshWindowMs: number;
  #access: ParticipantAccess | null = null;
  #generation = 0;
  #refresh: Promise<ParticipantAccess> | null = null;
  #refreshReplacesMedia = false;

  constructor(provider: ChalkSessionAccessProvider, now: () => number, refreshWindowMs = DEFAULT_REFRESH_WINDOW_MS) {
    this.#provider = provider;
    this.#now = now;
    this.#refreshWindowMs = refreshWindowMs;
  }

  get current(): ParticipantAccess | null {
    return this.#access;
  }

  async initialize(): Promise<ParticipantAccess> {
    if (this.#access) return this.#access;
    return this.#request("join", false);
  }

  async getSyncToken(reason: ChalkSessionAccessReason = "sync_recovery"): Promise<ParticipantSyncCredential> {
    const access = await this.#fresh(reason, false);
    return access.sync.token;
  }

  async getMediaToken(): Promise<ParticipantMediaCredential> {
    const access = await this.#fresh("scheduled_refresh", false);
    return access.media.token;
  }

  refresh(reason: Exclude<ChalkSessionAccessReason, "join">, replaceMediaConnection: boolean): Promise<ParticipantAccess> {
    return this.#request(reason, replaceMediaConnection);
  }

  millisecondsUntilRefresh(): number | null {
    if (!this.#access) return null;
    return Math.max(0, Math.min(expiresAt(this.#access.sync.expiresAt), expiresAt(this.#access.media.expiresAt)) - this.#now() - this.#refreshWindowMs);
  }

  clear(): void {
    this.#generation++;
    this.#access = null;
    this.#refresh = null;
    this.#refreshReplacesMedia = false;
  }

  async #fresh(reason: ChalkSessionAccessReason, replaceMediaConnection: boolean): Promise<ParticipantAccess> {
    const current = this.#access;
    if (!current || this.millisecondsUntilRefresh() === 0) return this.#request(reason, replaceMediaConnection);
    return current;
  }

  #request(reason: ChalkSessionAccessReason, replaceMediaConnection: boolean): Promise<ParticipantAccess> {
    if (this.#refresh) {
      if (replaceMediaConnection && !this.#refreshReplacesMedia) return this.#refresh.then(() => this.#request(reason, true));
      return this.#refresh;
    }
    const previous = this.#access;
    const generation = this.#generation;
    const request = Object.freeze({
      reason,
      replaceMediaConnection,
      ...(previous
        ? {
            currentMediaToken: previous.media.token,
            expectedParticipantGeneration: previous.subject.participantGeneration,
          }
        : {}),
    });
    const refresh = Promise.resolve(this.#provider(request))
      .then(parseParticipantAccess)
      .then((next) => {
        if (generation !== this.#generation) throw new TypeError("Participant access request was invalidated");
        validateExpiration(next, this.#now());
        if (previous) validateRefresh(previous, next, replaceMediaConnection);
        this.#access = next;
        return next;
      })
      .finally(() => {
        if (this.#refresh === refresh) {
          this.#refresh = null;
          this.#refreshReplacesMedia = false;
        }
      });
    this.#refresh = refresh;
    this.#refreshReplacesMedia = replaceMediaConnection;
    return refresh;
  }
}

function validateExpiration(access: ParticipantAccess, now: number): void {
  if (expiresAt(access.sync.expiresAt) <= now || expiresAt(access.media.expiresAt) <= now) throw new TypeError("Participant access is expired");
}

function validateRefresh(previous: ParticipantAccess, next: ParticipantAccess, replaceMediaConnection: boolean): void {
  const previousSubject = previous.subject;
  const nextSubject = next.subject;
  if (
    previousSubject.tenantId !== nextSubject.tenantId ||
    previousSubject.roomId !== nextSubject.roomId ||
    previousSubject.sessionId !== nextSubject.sessionId ||
    previousSubject.participantSessionId !== nextSubject.participantSessionId ||
    previousSubject.participantGeneration !== nextSubject.participantGeneration
  ) {
    throw new TypeError("Participant access refresh changed its subject");
  }
  if (!replaceMediaConnection && previous.media.clientPayload.connectionId !== next.media.clientPayload.connectionId) {
    throw new TypeError("Participant access refresh unexpectedly replaced its media connection");
  }
}

function expiresAt(value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new TypeError("Participant access expiration is invalid");
  return timestamp;
}
