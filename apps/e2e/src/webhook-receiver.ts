import { createHmac, timingSafeEqual } from "node:crypto";

export type CapturedWebhook = {
	receivedAt: Date;
	headers: Headers;
	bodyBytes: Uint8Array;
	bodyText: string;
	json: unknown;
};

export type WebhookReceiver = {
	url: string;
	waitForWebhook: (timeoutMs: number) => Promise<CapturedWebhook>;
	getCaptured: () => CapturedWebhook[];
	close: () => Promise<void>;
};

function isHexString(s: string): boolean {
	return /^[a-f0-9]+$/i.test(s);
}

function computeSignature(secret: string, timestamp: string, body: Uint8Array): string {
	const message = `${timestamp}.${new TextDecoder().decode(body)}`;
	const hex = createHmac("sha256", secret).update(message).digest("hex");
	return `sha256=${hex}`;
}

function constantTimeEqual(a: string, b: string): boolean {
	const aa = Buffer.from(a);
	const bb = Buffer.from(b);
	if (aa.length !== bb.length) return false;
	return timingSafeEqual(aa, bb);
}

export function startWebhookReceiver(opts: { port: number; secret: string }): WebhookReceiver {
	const captured: CapturedWebhook[] = [];
	const waiters: Array<(w: CapturedWebhook) => void> = [];

	const server = Bun.serve({
		port: opts.port,
		fetch: async (req) => {
			if (req.method !== "POST") {
				return new Response("Method Not Allowed", { status: 405 });
			}

			const headers = new Headers(req.headers);
			const signature = headers.get("X-Chalk-Signature") ?? "";
			const timestamp = headers.get("X-Chalk-Timestamp") ?? "";

			const bodyBuf = new Uint8Array(await req.arrayBuffer());
			const bodyText = new TextDecoder().decode(bodyBuf);

			if (!signature || !timestamp) {
				return new Response(
					JSON.stringify({ error: "missing X-Chalk-Signature or X-Chalk-Timestamp" }),
					{ status: 400, headers: { "Content-Type": "application/json" } },
				);
			}

			const expected = computeSignature(opts.secret, timestamp, bodyBuf);

			let signatureOk = false;
			if (signature.startsWith("sha256=")) {
				signatureOk = constantTimeEqual(signature, expected);
			} else if (signature.length === 64 && isHexString(signature)) {
				signatureOk = constantTimeEqual(signature, expected.slice("sha256=".length));
			}

			if (!signatureOk) {
				return new Response(JSON.stringify({ error: "invalid signature" }), {
					status: 401,
					headers: { "Content-Type": "application/json" },
				});
			}

			let json: unknown;
			try {
				json = JSON.parse(bodyText);
			} catch {
				return new Response(JSON.stringify({ error: "invalid JSON" }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				});
			}

			const webhook: CapturedWebhook = {
				receivedAt: new Date(),
				headers,
				bodyBytes: bodyBuf,
				bodyText,
				json,
			};
			captured.push(webhook);
			for (const resolve of waiters.splice(0, waiters.length)) resolve(webhook);

			return new Response(JSON.stringify({ received: true, bytes: bodyBuf.byteLength }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		},
	});

	return {
		url: `http://localhost:${server.port}`,
		getCaptured: () => [...captured],
		waitForWebhook: async (timeoutMs) => {
			if (captured.length > 0) return captured[captured.length - 1]!;
			return await new Promise<CapturedWebhook>((resolve, reject) => {
				const timeout = setTimeout(() => {
					const idx = waiters.indexOf(resolve);
					if (idx >= 0) waiters.splice(idx, 1);
					reject(new Error(`Timed out waiting for webhook after ${timeoutMs}ms`));
				}, timeoutMs);
				waiters.push((w) => {
					clearTimeout(timeout);
					resolve(w);
				});
			});
		},
		close: async () => {
			server.stop(true);
		},
	};
}
