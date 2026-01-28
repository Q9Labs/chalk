/**
 * Webhook verification and parsing handler
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/webhooks
 */

import { Schema } from "@effect/schema";
import { ChalkError, ChalkErrorCode } from "../errors/chalk-error";
import { WebhookPayload } from "./schemas";

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
		async verify(
			body: string,
			signature: string,
			timestamp: string,
		): Promise<WebhookEvent> {
			// 1. Verify timestamp freshness
			const ts = parseInt(timestamp, 10);
			const now = Math.floor(Date.now() / 1000);
			if (isNaN(ts) || Math.abs(now - ts) > tolerance) {
				throw new ChalkError(
					ChalkErrorCode.WEBHOOK_TIMESTAMP_EXPIRED,
					"Webhook timestamp outside tolerance window",
				);
			}

			// 2. Verify HMAC signature
			const hash = await createHmacSignature(secret, `${timestamp}.${body}`);
			const expectedSig = `sha256=${hash}`;

			if (!constantTimeEqual(signature, expectedSig)) {
				throw new ChalkError(
					ChalkErrorCode.WEBHOOK_SIGNATURE_INVALID,
					"Invalid webhook signature",
				);
			}

			// 3. Parse and validate payload
			let parsed: unknown;
			try {
				parsed = JSON.parse(body);
			} catch {
				throw new ChalkError(
					ChalkErrorCode.WEBHOOK_PAYLOAD_INVALID,
					"Invalid JSON in webhook body",
				);
			}

			try {
				const result = Schema.decodeUnknownSync(WebhookPayload)(parsed);
				return { type: result.event, payload: result };
			} catch (err) {
				throw new ChalkError(
					ChalkErrorCode.WEBHOOK_PAYLOAD_INVALID,
					"Webhook payload validation failed",
					{ cause: err instanceof Error ? err : undefined },
				);
			}
		},
	};
}
