/**
 * Webhook verification and parsing handler
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/webhooks
 */

import { Schema } from "@effect/schema";
import { Effect } from "effect";
import { ChalkError, ChalkErrorCode } from "../errors/chalk-error";
import {
	WebhookPayloadError,
	WebhookSignatureError,
	WebhookTimestampError,
} from "./errors";
import { type WebhookPayload, WebhookPayloadFromJson } from "./schemas";

/**
 * Constant-time string comparison to prevent timing attacks.
 * Works in both browser and Node.js environments.
 */
function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) {
		return false;
	}
	let result = 0;
	for (let i = 0; i < a.length; i++) {
		result |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return result === 0;
}

/**
 * Create HMAC-SHA256 signature using Web Crypto API (works in browser and Node.js)
 */
async function createHmacSignature(
	secret: string,
	message: string,
): Promise<string> {
	const encoder = new TextEncoder();
	const keyData = encoder.encode(secret);
	const messageData = encoder.encode(message);

	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		keyData,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);

	const signature = await crypto.subtle.sign("HMAC", cryptoKey, messageData);
	const hashArray = Array.from(new Uint8Array(signature));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface WebhookHandlerOptions {
	/** Webhook signing secret from tenant config */
	secret: string;
	/** Timestamp tolerance in seconds (default: 300) */
	tolerance?: number;
}

export interface WebhookEvent {
	type: "meeting.recording_ready";
	payload: Schema.Schema.Type<typeof WebhookPayload>;
}

/**
 * Effect pipeline that verifies signature, timestamp, and schema in sequence.
 */
function verifyEffect(
	body: string,
	signature: string,
	timestamp: string,
	secret: string,
	tolerance: number,
) {
	return Effect.gen(function* () {
		// 1. Input guards
		if (typeof body !== "string" || body.length === 0) {
			return yield* new WebhookPayloadError({
				message: "Webhook body must be a non-empty string",
				recoverable: false,
			});
		}
		if (typeof signature !== "string" || signature.length === 0) {
			return yield* new WebhookSignatureError({
				message: "Webhook signature header is missing",
				recoverable: false,
			});
		}
		if (typeof timestamp !== "string" || timestamp.length === 0) {
			return yield* new WebhookTimestampError({
				message: "Webhook timestamp header is missing",
				recoverable: false,
				receivedTimestamp: String(timestamp),
				toleranceSeconds: tolerance,
			});
		}

		// 2. Timestamp freshness
		const ts = parseInt(timestamp, 10);
		const now = Math.floor(Date.now() / 1000);
		const drift = Math.abs(now - ts);

		if (Number.isNaN(ts) || drift > tolerance) {
			return yield* new WebhookTimestampError({
				message: "Webhook timestamp outside tolerance window",
				recoverable: false,
				receivedTimestamp: timestamp,
				toleranceSeconds: tolerance,
			});
		}

		yield* Effect.logDebug("Webhook timestamp verified").pipe(
			Effect.annotateLogs({ timestamp, drift }),
		);

		// 3. HMAC signature verification
		const hash = yield* Effect.tryPromise({
			try: () => createHmacSignature(secret, `${timestamp}.${body}`),
			catch: (err) =>
				new WebhookSignatureError({
					message: `HMAC computation failed: ${err instanceof Error ? err.message : String(err)}`,
					recoverable: false,
				}),
		});

		const expectedSig = `sha256=${hash}`;
		if (!constantTimeEqual(signature, expectedSig)) {
			return yield* new WebhookSignatureError({
				message: "Invalid webhook signature",
				recoverable: false,
			});
		}

		yield* Effect.logDebug("Webhook signature verified");

		// 4. Parse JSON + validate schema atomically
		const result = yield* Schema.decode(WebhookPayloadFromJson)(body).pipe(
			Effect.mapError(
				(parseError) =>
					new WebhookPayloadError({
						message: "Webhook payload validation failed",
						recoverable: false,
						cause: parseError,
					}),
			),
		);

		yield* Effect.logDebug("Webhook payload validated").pipe(
			Effect.annotateLogs({
				event: result.event,
				meetingId: result.meeting.id,
			}),
		);

		return { type: result.event, payload: result } satisfies WebhookEvent;
	});
}

/**
 * Create a webhook handler for verifying and parsing Chalk webhooks
 *
 * @example
 * ```ts
 * const handler = createWebhookHandler({ secret: process.env.CHALK_WEBHOOK_SECRET });
 *
 * const event = handler.verify(
 *   req.body,
 *   req.headers['x-chalk-signature'],
 *   req.headers['x-chalk-timestamp']
 * );
 *
 * if (event.type === 'meeting.recording_ready') {
 *   console.log('Meeting:', event.payload.meeting.name);
 * }
 * ```
 */
export function createWebhookHandler(options: WebhookHandlerOptions) {
	const { secret, tolerance = 300 } = options;

	return {
		/**
		 * Verify and parse a webhook request
		 * @param body - Raw request body string
		 * @param signature - X-Chalk-Signature header
		 * @param timestamp - X-Chalk-Timestamp header
		 * @throws {ChalkError} If verification fails
		 */
		verify(
			body: string,
			signature: string,
			timestamp: string,
		): Promise<WebhookEvent> {
			return Effect.runPromise(
				verifyEffect(body, signature, timestamp, secret, tolerance).pipe(
					Effect.catchTags({
						WebhookTimestampError: (e) =>
							Effect.fail(
								new ChalkError(
									ChalkErrorCode.WEBHOOK_TIMESTAMP_EXPIRED,
									e.message,
								),
							),
						WebhookSignatureError: (e) =>
							Effect.fail(
								new ChalkError(
									ChalkErrorCode.WEBHOOK_SIGNATURE_INVALID,
									e.message,
								),
							),
						WebhookPayloadError: (e) =>
							Effect.fail(
								new ChalkError(
									ChalkErrorCode.WEBHOOK_PAYLOAD_INVALID,
									e.message,
									{ cause: e.cause instanceof Error ? e.cause : undefined },
								),
							),
					}),
				),
			);
		},
	};
}
