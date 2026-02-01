import postgres from "postgres";
import { loadConfig } from "./config";
import { startWebhookReceiver } from "./webhook-receiver";
import { startTunnel } from "./tunnel";
import {
	assertApiRecordingState,
	assertWebhookDelivery,
	buildUpdatedWebhookConfig,
	decodeTenantConfigFromApi,
	extractPostMeetingWebhookConfig,
	type AssertionResult,
	type TenantPostMeetingWebhookConfig,
} from "./assertions";
import { generateR2PresignedUrl, triggerSimulatedCloudflareWebhook } from "./trigger";
import { registerTeardown } from "./teardown";

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
	const resp = await fetch(url, init);
	if (!resp.ok) {
		const text = await resp.text().catch(() => "");
		throw new Error(`HTTP ${resp.status} ${url} ${text}`);
	}
	return (await resp.json()) as T;
}

function printResults(results: AssertionResult[]): boolean {
	let allOk = true;
	for (const r of results) {
		if (r.ok) {
			console.log(`PASS  ${r.name}`);
		} else {
			allOk = false;
			console.error(`FAIL  ${r.name}${r.details ? ` — ${r.details}` : ""}`);
		}
	}
	return allOk;
}

async function main(): Promise<void> {
	const loaded = loadConfig();
	if (!loaded.ok) {
		const out = loaded.skipped ? console.log : console.error;
		out(loaded.reason);
		process.exit(loaded.skipped ? 0 : 1);
	}

	const cfg = loaded.config;
	console.log(`E2E webhook harness starting (timeout=${cfg.timeoutMs}ms, persistent=${cfg.persistent})`);

	const receiver = startWebhookReceiver({ port: cfg.webhookPort, secret: cfg.webhookSecret });
	let tunnel: { publicUrl: string; kill: () => void } | null = null;

	const unregister = registerTeardown(async () => {
		try {
			tunnel?.kill();
		} finally {
			await receiver.close();
		}
	});

	try {
		// JWT for room/recording endpoints
		const tokenResp = await fetchJson<{ access_token: string }>(`${cfg.apiBaseUrl}/api/v1/auth/token`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ api_key: cfg.apiKey }),
		});
		const jwt = tokenResp.access_token;

		// Room info (cloudflare_meeting_id)
		const room = await fetchJson<{ cloudflare_meeting_id: string }>(`${cfg.apiBaseUrl}/api/v1/rooms/${cfg.roomId}`, {
			headers: { Authorization: `Bearer ${jwt}` },
		});

		// Tenant config (needs X-API-Key)
		const tenant = await fetchJson<{ tenant_config: string }>(`${cfg.apiBaseUrl}/api/v1/tenants/${cfg.tenantId}`, {
			headers: { "X-API-Key": cfg.apiKey },
		});

		const tenantConfigObj = decodeTenantConfigFromApi(tenant.tenant_config);
		const existingWebhookCfg = extractPostMeetingWebhookConfig(tenantConfigObj);

		console.log("Assertions enabled by tenant config:", {
			include_recording:
				existingWebhookCfg.include_recording ||
				(existingWebhookCfg.include_transcript ||
				existingWebhookCfg.include_summary ||
				existingWebhookCfg.include_action_items
					? false
					: true),
			include_transcript: existingWebhookCfg.include_transcript,
			include_summary: existingWebhookCfg.include_summary,
			include_action_items: existingWebhookCfg.include_action_items,
			transcription_provider: existingWebhookCfg.transcription?.provider,
		});

		// DB reset
		{
			const sql = postgres(cfg.databaseUrl, { max: 1 });
			try {
				await sql`
					UPDATE recordings
					SET
						status = 'processing',
						storage_provider = NULL,
						storage_path = NULL,
						size_bytes = NULL,
						duration_seconds = NULL
					WHERE id = ${cfg.recordingId}::uuid
				`;
			} finally {
				await sql.end({ timeout: 5 });
			}
		}

		// Tunnel
		tunnel = await startTunnel({ port: cfg.webhookPort, timeoutMs: 30_000 });
		console.log(`Tunnel URL: ${tunnel.publicUrl}`);

		// Patch tenant config: enable + set URL + secret (preserve include flags & providers)
		const updatedWebhookCfg: TenantPostMeetingWebhookConfig = buildUpdatedWebhookConfig(existingWebhookCfg, {
			url: tunnel.publicUrl,
			secret: cfg.webhookSecret,
		});

		await fetchJson(`${cfg.apiBaseUrl}/api/v1/tenants/${cfg.tenantId}/config`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", "X-API-Key": cfg.apiKey },
			body: JSON.stringify({ post_meeting_webhook: updatedWebhookCfg }),
		});

		// Presigned URL for fixture recording (source for API download)
		const presigned = await generateR2PresignedUrl({
			accountId: cfg.r2AccountId,
			accessKeyId: cfg.r2AccessKeyId,
			secretAccessKey: cfg.r2SecretAccessKey,
			bucket: cfg.r2BucketName,
			key: cfg.r2TestRecordingKey,
			expiresInSeconds: 3600,
		});

		const outputFileName = cfg.r2TestRecordingKey.split("/").pop() || "e2e-test-recording.mp4";

		// Fire simulated Cloudflare webhook
		await triggerSimulatedCloudflareWebhook({
			apiBaseUrl: cfg.apiBaseUrl,
			cfRecordingId: cfg.cfRecordingId,
			downloadUrl: presigned.url,
			downloadUrlExpiryIso: presigned.expiresAtIso,
			roomCloudflareMeetingId: room.cloudflare_meeting_id,
			outputFileName,
		});

		// Wait for post-meeting webhook delivery
		console.log(`Waiting for post-meeting webhook at ${receiver.url} (public via tunnel)...`);
		const captured = await receiver.waitForWebhook(cfg.timeoutMs);

		const webhookResults = assertWebhookDelivery({
			headers: captured.headers,
			bodyText: captured.bodyText,
			payload: captured.json,
			webhookSecret: cfg.webhookSecret,
			roomId: cfg.roomId,
			recordingId: cfg.recordingId,
			config: updatedWebhookCfg,
		});

		const apiResults = await assertApiRecordingState({
			apiBaseUrl: cfg.apiBaseUrl,
			jwt,
			recordingId: cfg.recordingId,
			timeoutMs: cfg.timeoutMs,
		});

		const allOk = printResults([...webhookResults, ...apiResults]);
		if (!allOk) process.exitCode = 1;

		if (cfg.persistent) {
			console.log("Persistent mode: keeping receiver + tunnel alive.");
			// eslint-disable-next-line no-constant-condition
			while (true) {
				// wait indefinitely for next delivery
				const next = await receiver.waitForWebhook(24 * 60 * 60 * 1000);
				console.log(`\nReceived webhook at ${next.receivedAt.toISOString()}`);
				printResults(
					assertWebhookDelivery({
						headers: next.headers,
						bodyText: next.bodyText,
						payload: next.json,
						webhookSecret: cfg.webhookSecret,
						roomId: cfg.roomId,
						recordingId: cfg.recordingId,
						config: updatedWebhookCfg,
					}),
				);
			}
		}
	} finally {
		unregister();
		tunnel?.kill();
		await receiver.close();
	}
}

await main();
