/**
 * Wide Event Context - accumulator for building events
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/wide-events
 */

import type { WideEventCollector } from "./collector";
import type { WideEvent, WideEventError, WideEventOutcome } from "./types";
import { generateEventId, getSdkEnvironment } from "./environment";

/**
 * WideEventContext - accumulates data for a single wide event
 *
 * Usage:
 * ```ts
 * const ctx = wideEvents.start("room.join");
 * ctx.set("input", { roomId, displayName });
 * ctx.markPhase("api");
 * // ... do API work ...
 * ctx.markPhase("rtk.init");
 * // ... init RTK ...
 * ctx.complete("success", { participantCount: 5 });
 * ```
 */
export class WideEventContext {
  private readonly eventId: string;
  private readonly eventType: string;
  private readonly startTime: number;
  private readonly collector: WideEventCollector;

  private phaseStartTime: number;
  private phases: Record<string, number> = {};
  private data: Record<string, unknown> = {};
  private currentPhase: string | null = null;
  private completed = false;

  constructor(eventType: string, collector: WideEventCollector) {
    this.eventId = generateEventId();
    this.eventType = eventType;
    this.startTime = performance.now();
    this.phaseStartTime = this.startTime;
    this.collector = collector;
  }

  /**
   * Set a top-level data field
   */
  set(key: string, value: unknown): this {
    this.data[key] = value;
    return this;
  }

  /**
   * Set a nested data field (e.g., setNested("api", "statusCode", 200))
   */
  setNested(category: string, key: string, value: unknown): this {
    if (!this.data[category] || typeof this.data[category] !== "object") {
      this.data[category] = {};
    }
    (this.data[category] as Record<string, unknown>)[key] = value;
    return this;
  }

  /**
   * Merge multiple fields into data
   */
  merge(fields: Record<string, unknown>): this {
    Object.assign(this.data, fields);
    return this;
  }

  /**
   * Mark the start of a new phase
   * Automatically records the duration of the previous phase
   */
  markPhase(phaseName: string): this {
    const now = performance.now();

    // Record duration of previous phase
    if (this.currentPhase) {
      this.phases[this.currentPhase] = Math.round(now - this.phaseStartTime);
    }

    this.currentPhase = phaseName;
    this.phaseStartTime = now;
    return this;
  }

  /**
   * Complete the event with success outcome
   */
  complete(outcome: "success", resultData?: Record<string, unknown>): void;
  /**
   * Complete the event with error outcome
   */
  complete(outcome: "error" | "timeout", error: unknown): void;
  complete(outcome: WideEventOutcome, dataOrError?: Record<string, unknown> | unknown): void {
    if (this.completed) return;
    this.completed = true;

    const now = performance.now();
    const durationMs = Math.round(now - this.startTime);

    // Record final phase duration
    if (this.currentPhase) {
      this.phases[this.currentPhase] = Math.round(now - this.phaseStartTime);
    }

    // Build error object if needed
    let error: WideEventError | undefined;
    if (outcome === "error" || outcome === "timeout") {
      const err = dataOrError;
      if (err instanceof Error) {
        error = {
          code: (err as Error & { code?: string }).code ?? "UNKNOWN_ERROR",
          message: err.message,
          stack: this.collector.config.includeDebugInfo ? err.stack : undefined,
        };
      } else if (typeof err === "object" && err !== null && "code" in err && "message" in err) {
        const typed = err as { code: string; message: string };
        error = { code: typed.code, message: typed.message };
      } else {
        error = {
          code: "UNKNOWN_ERROR",
          message: String(err),
        };
      }
    } else if (dataOrError && typeof dataOrError === "object") {
      // Merge result data
      Object.assign(this.data, dataOrError);
    }

    const event: WideEvent = {
      eventId: this.eventId,
      eventType: this.eventType,
      timestamp: new Date().toISOString(),
      sdk: getSdkEnvironment(),
      sessionId: this.collector.sessionId,
      roomId: this.collector.roomId ?? undefined,
      participantId: this.collector.participantId ?? undefined,
      durationMs,
      phases: Object.keys(this.phases).length > 0 ? this.phases : undefined,
      outcome,
      error,
      data: this.data,
    };

    this.collector.emit(event);
  }

  /**
   * Abandon the context without emitting (for error recovery)
   */
  abandon(): void {
    this.completed = true;
  }

  /**
   * Check if this context has been completed
   */
  get isCompleted(): boolean {
    return this.completed;
  }
}
