import type { WideEvent } from "./types";

export type AxiomWideEventsConfig = {
	token: string;
	dataset: string;
	/**
	 * Axiom API base URL.
	 * @default "https://api.axiom.co"
	 */
	endpoint?: string;
	/**
	 * Flush interval for batching.
	 * @default 2000
	 */
	flushIntervalMs?: number;
	/**
	 * Max events per ingest request.
	 * @default 50
	 */
	maxBatchSize?: number;
	/**
	 * Log internal handler failures to console.
	 * @default false
	 */
	debug?: boolean;
};

export type AxiomWideEventsHandler = {
	handler: (event: WideEvent) => void;
	flush: () => Promise<void>;
	shutdown: () => Promise<void>;
};

const defaultEndpoint = "https://api.axiom.co";

const isBrowser = () => typeof window !== "undefined";

export function createAxiomWideEventsHandler(
	config: AxiomWideEventsConfig,
): AxiomWideEventsHandler {
	const endpoint = (config.endpoint ?? defaultEndpoint).replace(/\/$/, "");
	const dataset = config.dataset;
	const token = config.token;
	const flushIntervalMs = config.flushIntervalMs ?? 2000;
	const maxBatchSize = config.maxBatchSize ?? 50;
	const debug = config.debug ?? false;

	if (isBrowser() && debug) {
		// eslint-disable-next-line no-console
		console.warn(
			"[Chalk] Axiom wide-events handler is running in the browser; token is client-exposed",
		);
	}

	const ingestUrl = `${endpoint}/v1/datasets/${encodeURIComponent(dataset)}/ingest`;

	let queue: WideEvent[] = [];
	let timer: ReturnType<typeof setInterval> | null = null;
	let flushing: Promise<void> | null = null;

	const logDebug = (...args: unknown[]) => {
		if (!debug) return;
		// eslint-disable-next-line no-console
		console.log("[Chalk][Axiom]", ...args);
	};

	const flushBatch = async (batch: WideEvent[]): Promise<void> => {
		if (batch.length === 0) return;
		const res = await fetch(ingestUrl, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(batch),
		});
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(
				`Axiom ingest failed: ${res.status} ${res.statusText} ${text}`.trim(),
			);
		}
	};

	const flush = async (): Promise<void> => {
		if (flushing) return flushing;

		flushing = (async () => {
			while (queue.length > 0) {
				const batch = queue.slice(0, maxBatchSize);
				queue = queue.slice(batch.length);
				try {
					await flushBatch(batch);
					logDebug("flushed", batch.length);
				} catch (err) {
					// Put events back and bail; next tick can retry.
					queue = batch.concat(queue);
					if (debug) {
						// eslint-disable-next-line no-console
						console.error("[Chalk][Axiom] flush failed", err);
					}
					return;
				}
			}
		})().finally(() => {
			flushing = null;
		});

		return flushing;
	};

	const ensureTimer = () => {
		if (timer) return;
		timer = setInterval(() => {
			void flush();
		}, flushIntervalMs);
	};

	const handler = (event: WideEvent) => {
		if (!token || !dataset) return;
		queue.push(event);
		ensureTimer();
		if (queue.length >= maxBatchSize) {
			void flush();
		}
	};

	const shutdown = async () => {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		await flush();
	};

	return { handler, flush, shutdown };
}

