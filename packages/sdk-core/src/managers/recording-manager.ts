/**
 * Recording manager for Chalk SDK
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/managers
 */

import { ChalkError, ChalkErrorCode } from "../errors/chalk-error";
import type { ConferenceSession } from "../room";
import { StateContainer } from "../state/state-container";
import type { Recording, RecordingStatus } from "../types";
import { TypedEventEmitter } from "../utils/typed-emitter";

/** Recording manager state */
export interface RecordingState {
	/** Whether recording is active */
	readonly isRecording: boolean;
	/** Whether recording is starting */
	readonly isStarting: boolean;
	/** Whether recording is stopping */
	readonly isStopping: boolean;
	/** Current recording ID */
	readonly recordingId: string | null;
	/** Current recording status */
	readonly status: RecordingStatus | null;
}

/** Recording manager events */
export interface RecordingManagerEvents {
	/** Recording started */
	started: { recordingId: string };
	/** Recording stopped */
	stopped: { recording: Recording };
	/** Error occurred */
	error: ChalkError;
}

/**
 * Manages room recording
 *
 * Recording is handled by Cloudflare RealtimeKit - the SDK provides
 * start/stop controls while Cloudflare handles the actual recording.
 */
export class RecordingManager extends StateContainer<RecordingState> {
	private readonly events = new TypedEventEmitter<RecordingManagerEvents>();
	private room: ConferenceSession | null = null;
	private apiStartRecording?: () => Promise<string>;
	private apiStopRecording?: () => Promise<void>;

	constructor(_debug = false) {
		super({
			isRecording: false,
			isStarting: false,
			isStopping: false,
			recordingId: null,
			status: null,
		});
	}

	/** Subscribe to recording events */
	on<K extends keyof RecordingManagerEvents>(
		event: K,
		handler: (data: RecordingManagerEvents[K]) => void,
	): () => void {
		return this.events.on(event, handler);
	}

	/** Attach ConferenceSession instance */
	attachRoom(room: ConferenceSession): void {
		this.room = room;
		this.setupRoomListeners();
		this.syncFromRoom();
	}

	/** Set API callbacks for recording control */
	setApiCallbacks(
		startRecording: () => Promise<string>,
		stopRecording: () => Promise<void>,
	): void {
		this.apiStartRecording = startRecording;
		this.apiStopRecording = stopRecording;
	}

	private syncFromRoom(): void {
		if (!this.room) return;

		this.setState({
			isRecording: this.room.isRecording,
		});
	}

	private setupRoomListeners(): void {
		if (!this.room) return;

		this.room.on("recording.started", ({ recordingId }) => {
			this.setState({
				isRecording: true,
				isStarting: false,
				recordingId,
				status: "recording",
			});
			this.events.emit("started", { recordingId });
		});

		this.room.on("recording.stopped", (recording) => {
			this.setState({
				isRecording: false,
				isStopping: false,
				status: "processing",
			});
			this.events.emit("stopped", { recording });
		});
	}

	/** Start recording */
	async start(): Promise<string> {
		if (!this.room) {
			throw new ChalkError(
				ChalkErrorCode.NOT_IN_ROOM,
				"Not connected to a room",
			);
		}

		if (this.getState().isRecording) {
			throw new ChalkError(
				ChalkErrorCode.RECORDING_IN_PROGRESS,
				"Recording is already in progress",
			);
		}

		if (!this.apiStartRecording) {
			throw new ChalkError(
				ChalkErrorCode.RECORDING_FAILED,
				"Recording API not configured",
			);
		}

		this.setState({ isStarting: true });

		try {
			const recordingId = await this.apiStartRecording();

			this.setState({
				isRecording: true,
				isStarting: false,
				recordingId,
				status: "recording",
			});

			this.events.emit("started", { recordingId });
			return recordingId;
		} catch (err) {
			this.setState({ isStarting: false });
			const error = ChalkError.wrap(err);
			this.events.emit("error", error);
			throw error;
		}
	}

	/** Stop recording */
	async stop(): Promise<void> {
		if (!this.room) {
			throw new ChalkError(
				ChalkErrorCode.NOT_IN_ROOM,
				"Not connected to a room",
			);
		}

		if (!this.getState().isRecording) {
			throw new ChalkError(
				ChalkErrorCode.NO_ACTIVE_RECORDING,
				"No active recording to stop",
			);
		}

		if (!this.apiStopRecording) {
			throw new ChalkError(
				ChalkErrorCode.RECORDING_FAILED,
				"Recording API not configured",
			);
		}

		this.setState({ isStopping: true });

		try {
			await this.apiStopRecording();
			// State will be updated via room event
		} catch (err) {
			this.setState({ isStopping: false });
			const error = ChalkError.wrap(err);
			this.events.emit("error", error);
			throw error;
		}
	}

	/** Cleanup resources */
	dispose(): void {
		this.events.removeAllListeners();
	}
}
