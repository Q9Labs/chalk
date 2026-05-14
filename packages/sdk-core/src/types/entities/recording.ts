/**
 * Recording entity types for Chalk SDK
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/types
 */

/**
 * Status of a recording
 */
export type RecordingStatus = "recording" | "processing" | "ready" | "archived" | "deleted";

/**
 * Storage provider for recordings
 */
export type StorageProvider = "r2" | "s3_glacier";

/**
 * Represents a room recording
 *
 * Recording is handled by Cloudflare RealtimeKit. The SDK provides
 * start/stop controls; Cloudflare handles the actual recording and storage.
 *
 * @example
 * ```ts
 * // Start recording (host only)
 * await session.recording.start();
 *
 * // Listen for recording events
 * session.on('recording:started', ({ recordingId }) => {
 *   showRecordingIndicator();
 * });
 * ```
 */
export interface Recording {
  /** Unique recording identifier (UUID) */
  readonly id: string;

  /** ConferenceSession that was recorded */
  roomId: string;

  /** Current status */
  status: RecordingStatus;

  /** Cloudflare recording ID */
  cloudflareRecordingId?: string;

  /** Storage provider */
  storageProvider?: StorageProvider;

  /** Path to stored recording file */
  storagePath?: string;

  /** File size in bytes (available after processing) */
  sizeBytes?: number;

  /** Duration in seconds (available after processing) */
  durationSeconds?: number;

  /** When recording started */
  startedAt?: Date;

  /** When recording stopped */
  endedAt?: Date;

  /** When recording was archived to long-term storage */
  archivedAt?: Date;
}
