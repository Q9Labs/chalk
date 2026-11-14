import { backoffMs } from "../../lib/backoff";
import { DashboardRequestError, failureKind } from "../../lib/dashboard/client";

export type Load<T> = { readonly kind: "loading" } | { readonly kind: "error"; readonly error: unknown } | { readonly kind: "ready"; readonly data: T };

/** A status read's answer that changes the data already shown instead of replacing it. */
export class Change<T> {
  constructor(readonly apply: (current: T) => T) {}
}

export type Polling<T> = { interval: (data: T) => number | undefined; read: (data: T) => Promise<T | Change<T> | null>; visibility?: "status" };
export type Refresh = { force?: boolean; background?: boolean; status?: boolean };

/** What the machine needs from the page: the data on screen, the newest callbacks, and where to report. */
export type LoadHost<T> = {
  readonly ready: { current: T | undefined };
  readonly load: () => Promise<T>;
  readonly polling: () => Polling<T> | undefined;
  readonly emit: (state: Load<T>) => void;
  readonly signIn: () => void;
};

type Request = { kind: "status" | "load"; loads: number; writes: number };
type Answer<T> = { data: T } | { change: Change<T> };

const DEFAULT_INTERVAL_MS = 5000;
const MAX_BACKOFF_MS = 30000;

/**
 * One page's reads. A full read supersedes every earlier one, a write on the page supersedes a status read built
 * from older data, and failures back off. The machine is disposable: the page makes a new one when its key changes.
 */
export class LoadMachine<T> {
  // Full reads started: an answer from before the newest one is superseded by it.
  private loads = 0;
  // Writes made on the page: an answer built from older data can't overwrite one, but a Change applies on top.
  private writes = 0;
  private inFlight: Request | null = null;
  private active = true;
  private stopped = false;
  private failures = 0;
  private retryAt = 0;

  constructor(private readonly host: LoadHost<T>) {}

  start(): void {
    this.host.ready.current = undefined;
    this.host.emit({ kind: "loading" });
    this.refresh();
  }

  dispose(): void {
    this.active = false;
  }

  /** The page wrote new data: older answers must not replace it. */
  // fallow-ignore-next-line unused-class-member
  invalidate(): void {
    if (!this.active) return;
    this.writes++;
    if (this.inFlight?.kind !== "load") return;
    this.loads++;
    this.inFlight = null;
  }

  refresh({ force = false, background = true, status = false }: Refresh = {}): void {
    if (!this.active || this.stopped || (background && Date.now() < this.retryAt) || (this.inFlight && !force)) return;
    const poll = status ? this.host.polling() : undefined;
    const from = this.host.ready.current;
    const request: Request = poll && from !== undefined ? { kind: "status", loads: this.loads, writes: this.writes } : { kind: "load", loads: ++this.loads, writes: this.writes };
    this.inFlight = request;
    this.read(request, poll, from).then(
      (answer) => this.settle(request, answer),
      (error: unknown) => this.fail(request, error, background),
    );
  }

  private async read(request: Request, poll: Polling<T> | undefined, from: T | undefined): Promise<Answer<T>> {
    if (poll && from !== undefined) {
      const answer = await poll.read(from);
      if (answer instanceof Change) return { change: answer };
      if (answer !== null) return { data: answer };
      request.kind = "load";
      request.loads = ++this.loads;
    }
    return { data: await this.host.load() };
  }

  private settle(request: Request, answer: Answer<T>): void {
    if (!this.active) return;
    if (this.inFlight === request) this.inFlight = null;
    if (request.loads !== this.loads || ("data" in answer && request.kind === "status" && request.writes !== this.writes)) return;
    this.failures = 0;
    this.retryAt = 0;
    const { ready } = this.host;
    // The latest data moves at once, so the next read starts from this answer whenever React renders it.
    const data = "data" in answer ? answer.data : ready.current === undefined ? undefined : answer.change.apply(ready.current);
    if (data === undefined || data === ready.current) return;
    ready.current = data;
    this.host.emit({ kind: "ready", data });
  }

  private fail(request: Request, error: unknown, background: boolean): void {
    if (!this.active) return;
    if (this.inFlight === request) this.inFlight = null;
    if (request.loads !== this.loads) return;
    const kind = failureKind(error);
    if (kind === "sign-in") {
      // Nothing else can be read until the person signs in again.
      this.stopped = true;
      this.host.signIn();
      return;
    }
    this.failures = Math.min(this.failures + 1, 10);
    this.retryAt = Date.now() + this.backoff(error);
    // A failed background read keeps ready data on screen. Any other failure replaces it, so a later update can't
    // bring the old data back over the error.
    const { ready } = this.host;
    if (background && kind === "transient" && ready.current !== undefined) return;
    ready.current = undefined;
    this.host.emit({ kind: "error", error });
  }

  private backoff(error: unknown): number {
    if (error instanceof DashboardRequestError && error.retryAfterSeconds !== undefined) return error.retryAfterSeconds * 1000;
    const { current } = this.host.ready;
    const interval = current === undefined ? DEFAULT_INTERVAL_MS : (this.host.polling()?.interval(current) ?? DEFAULT_INTERVAL_MS);
    return backoffMs(this.failures + 1, interval, MAX_BACKOFF_MS);
  }
}
