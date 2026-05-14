#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const apiDir = path.resolve(__dirname, "..");
const openapiPath = path.join(apiDir, "openapi.yaml");

const METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

const jsonContent = (schema) => ({
	"application/json": {
		schema,
	},
});

const pngContent = {
	"image/png": {
		schema: {
			type: "string",
			format: "binary",
		},
	},
};

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });

const errorResponse = {
	description: "Error",
	content: jsonContent(ref("Error")),
};

const pathParam = (name, description, schema = { type: "string" }) => ({
	name,
	in: "path",
	required: true,
	description,
	schema,
});

const queryParam = (name, description, schema) => ({
	name,
	in: "query",
	required: false,
	description,
	schema,
});

const op = ({ summary, description, tags, security, parameters, requestBody, responses }) => ({
	summary,
	...(description ? { description } : {}),
	...(tags ? { tags } : {}),
	...(security ? { security } : {}),
	...(parameters ? { parameters } : {}),
	...(requestBody ? { requestBody } : {}),
	responses,
});

function ensureTag(spec, name, description) {
	if (!Array.isArray(spec.tags)) {
		spec.tags = [];
	}
	if (!spec.tags.some((tag) => tag.name === name)) {
		spec.tags.push({ name, description });
	}
}

function ensureSchema(spec, name, schema) {
	if (!spec.components) {
		spec.components = {};
	}
	if (!spec.components.schemas) {
		spec.components.schemas = {};
	}
	spec.components.schemas[name] = schema;
}

function ensureSecurityScheme(spec, name, scheme) {
	if (!spec.components) {
		spec.components = {};
	}
	if (!spec.components.securitySchemes) {
		spec.components.securitySchemes = {};
	}
	spec.components.securitySchemes[name] = scheme;
}

function ensureSchemas(spec) {
	ensureSchema(spec, "OpaqueObject", {
		type: "object",
		additionalProperties: true,
		description: "Opaque object returned directly from service/query layer.",
	});
	ensureSchema(spec, "OpaqueObjectArray", {
		type: "array",
		items: ref("OpaqueObject"),
	});
	ensureSchema(spec, "InternalAuthGoogleRequest", {
		type: "object",
		required: ["code"],
		properties: {
			code: { type: "string" },
		},
	});
	ensureSchema(spec, "InternalAuthUser", {
		type: "object",
		required: ["email"],
		properties: {
			email: { type: "string", format: "email" },
		},
	});
	ensureSchema(spec, "InternalAuthGoogleResponse", {
		type: "object",
		required: ["ok", "tenant_id", "user"],
		properties: {
			ok: { type: "boolean" },
			tenant_id: { type: "string", format: "uuid" },
			user: ref("InternalAuthUser"),
		},
	});
	ensureSchema(spec, "InternalAuthSessionResponse", {
		type: "object",
		required: ["user"],
		properties: {
			user: ref("InternalAuthUser"),
		},
	});
	ensureSchema(spec, "InternalAuthLogoutResponse", {
		type: "object",
		required: ["ok"],
		properties: {
			ok: { type: "boolean" },
		},
	});
	ensureSchema(spec, "InternalAuthAccessTokenResponse", {
		type: "object",
		required: ["access_token", "expires_in"],
		properties: {
			access_token: { type: "string" },
			expires_in: { type: "integer" },
		},
	});
	ensureSchema(spec, "InternalMeetingsResponse", {
		type: "object",
		required: ["meetings", "total", "limit", "offset"],
		properties: {
			meetings: ref("OpaqueObjectArray"),
			total: { type: "integer" },
			limit: { type: "integer" },
			offset: { type: "integer" },
		},
	});
	ensureSchema(spec, "OpsActorRequest", {
		type: "object",
		properties: {
			actor_id: { type: "string" },
			actor_kind: { type: "string" },
		},
	});
	ensureSchema(spec, "OpsDeclareIncidentRequest", {
		allOf: [
			ref("OpsActorRequest"),
			{
				type: "object",
				required: ["title", "severity"],
				properties: {
					incident_code: { type: "string" },
					title: { type: "string" },
					summary: { type: "string" },
					severity: { type: "string" },
					status: { type: "string" },
					visibility: { type: "string" },
					source_kind: { type: "string" },
					source_key: { type: "string" },
					component_ids: { type: "array", items: { type: "string" } },
					dedupe_key: { type: "string" },
					idempotency_key: { type: "string" },
					public_message: { type: "string" },
					public_title: { type: "string" },
					metadata: { type: "object", additionalProperties: true },
					event_message: { type: "string" },
					occurred_at: { type: "string", format: "date-time" },
				},
			},
		],
	});
	ensureSchema(spec, "OpsAddIncidentEventRequest", {
		allOf: [
			ref("OpsActorRequest"),
			{
				type: "object",
				required: ["event_type", "message"],
				properties: {
					event_type: { type: "string" },
					visibility: { type: "string" },
					message: { type: "string" },
					metadata: { type: "object", additionalProperties: true },
					idempotency_key: { type: "string" },
					event_at: { type: "string", format: "date-time" },
					transition_to: { type: "string" },
					public_message: { type: "string" },
					public_title: { type: "string" },
					updated_summary: { type: "string" },
				},
			},
		],
	});
	ensureSchema(spec, "OpsPublishIncidentRequest", {
		allOf: [
			ref("OpsActorRequest"),
			{
				type: "object",
				properties: {
					message: { type: "string" },
					public_message: { type: "string" },
					public_title: { type: "string" },
					event_at: { type: "string", format: "date-time" },
				},
			},
		],
	});
	ensureSchema(spec, "OpsResolveIncidentRequest", {
		allOf: [
			ref("OpsActorRequest"),
			{
				type: "object",
				properties: {
					message: { type: "string" },
					summary: { type: "string" },
					event_at: { type: "string", format: "date-time" },
				},
			},
		],
	});
	ensureSchema(spec, "OpsMaintenanceRequest", {
		allOf: [
			ref("OpsActorRequest"),
			{
				type: "object",
				required: ["title", "component_ids", "starts_at", "ends_at"],
				properties: {
					title: { type: "string" },
					summary: { type: "string" },
					component_ids: { type: "array", items: { type: "string" } },
					starts_at: { type: "string", format: "date-time" },
					ends_at: { type: "string", format: "date-time" },
					public_message: { type: "string" },
				},
			},
		],
	});
	ensureSchema(spec, "OpsIngestMonitorResultRequest", {
		type: "object",
		required: ["monitor_key", "status"],
		properties: {
			monitor_key: { type: "string" },
			status: { type: "string" },
			checked_at: { type: "string", format: "date-time" },
			run_id: { type: "string" },
			result_key: { type: "string" },
			http_status: { type: "integer", nullable: true },
			latency_ms: { type: "integer", nullable: true },
			error_code: { type: "string" },
			error_message: { type: "string" },
			details: { type: "object", additionalProperties: true },
			reported_source: { type: "string" },
			reported_emitter_id: { type: "string" },
		},
	});
	ensureSchema(spec, "OpsIngestHeartbeatRequest", {
		type: "object",
		required: ["heartbeat_key", "status"],
		properties: {
			heartbeat_key: { type: "string" },
			status: { type: "string" },
			event_at: { type: "string", format: "date-time" },
			event_key: { type: "string" },
			error_message: { type: "string" },
			details: { type: "object", additionalProperties: true },
			reported_source: { type: "string" },
			reported_emitter_id: { type: "string" },
		},
	});
	ensureSchema(spec, "OpsIngestMonitorResultResponse", {
		type: "object",
		required: ["result", "incident"],
		properties: {
			result: ref("OpaqueObject"),
			incident: {
				oneOf: [ref("OpaqueObject"), { type: "null" }],
			},
		},
	});
	ensureSchema(spec, "OpsIngestHeartbeatResponse", {
		type: "object",
		required: ["event", "incident"],
		properties: {
			event: ref("OpaqueObject"),
			incident: {
				oneOf: [ref("OpaqueObject"), { type: "null" }],
			},
		},
	});
	ensureSchema(spec, "OpsStatusSummaryResponse", {
		type: "object",
		additionalProperties: true,
	});
	ensureSchema(spec, "OpsIncidentDetailsResponse", {
		type: "object",
		required: ["incident", "events"],
		properties: {
			incident: ref("OpaqueObject"),
			events: ref("OpaqueObjectArray"),
		},
	});
	ensureSchema(spec, "WhatsNewResponse", {
		type: "object",
		required: ["version", "published_at", "title", "content"],
		properties: {
			version: { type: "string" },
			published_at: { type: "string", format: "date-time" },
			title: { type: "string" },
			content: { type: "string" },
			image_url: { type: "string" },
			release_type: { type: "string" },
		},
	});
	ensureSchema(spec, "WhatsNewReleasesResponse", {
		type: "object",
		required: ["releases"],
		properties: {
			releases: {
				type: "array",
				items: ref("WhatsNewResponse"),
			},
		},
	});
	ensureSchema(spec, "TranscriptionProvidersResponse", {
		type: "object",
		required: ["providers", "default_provider"],
		properties: {
			providers: {
				type: "array",
				items: ref("OpaqueObject"),
			},
			default_provider: { type: "string" },
		},
	});
	ensureSchema(spec, "QueueTranscriptionRequest", {
		type: "object",
		required: ["room_id"],
		properties: {
			room_id: { type: "string", format: "uuid" },
			provider: { type: "string" },
		},
	});
	ensureSchema(spec, "QueueTranscriptionResponse", {
		type: "object",
		required: ["transcript_id", "status"],
		properties: {
			transcript_id: { type: "string", format: "uuid" },
			status: { type: "string", enum: ["pending"] },
		},
	});
	ensureSchema(spec, "TranscriptionCallbackResponse", {
		type: "object",
		required: ["ok", "transcript", "status", "state_changed"],
		properties: {
			ok: { type: "boolean" },
			transcript: { type: "string", format: "uuid" },
			status: { type: "string" },
			state_changed: { type: "boolean" },
		},
	});
	ensureSchema(spec, "RecordingRecoverResponse", {
		type: "object",
		required: ["message", "recording_id"],
		properties: {
			message: { type: "string" },
			recording_id: { type: "string", format: "uuid" },
			cloudflare_status: { type: "string" },
			file_size: { type: "integer" },
			duration: { type: "integer" },
		},
	});
	ensureSchema(spec, "RecordingShareTokenResponse", {
		type: "object",
		required: ["share_token"],
		properties: {
			share_token: { type: "string" },
		},
	});
	ensureSchema(spec, "RecordingSyncResponse", {
		type: "object",
		required: ["message", "synced", "existing", "errors", "recordings"],
		properties: {
			message: { type: "string" },
			synced: { type: "integer" },
			existing: { type: "integer" },
			errors: {
				type: "array",
				items: { type: "string" },
			},
			recordings: {
				type: "array",
				items: ref("Recording"),
			},
		},
	});
	ensureSchema(spec, "BulkAddParticipantsRequest", {
		type: "object",
		required: ["participants"],
		properties: {
			participants: {
				type: "array",
				minItems: 1,
				items: {
					type: "object",
					required: ["display_name"],
					properties: {
						display_name: { type: "string" },
						external_user_id: { type: "string" },
						role: { type: "string" },
						metadata: { type: "object", additionalProperties: true },
					},
				},
			},
		},
	});
	ensureSchema(spec, "BulkAddParticipantsResult", {
		type: "object",
		required: ["display_name", "success"],
		properties: {
			participant_id: { type: "string", format: "uuid" },
			external_user_id: { type: "string" },
			display_name: { type: "string" },
			success: { type: "boolean" },
			access_token: { type: "string" },
			auth_token: { type: "string" },
			error: { type: "string" },
		},
	});
	ensureSchema(spec, "BulkAddParticipantsResponse", {
		type: "object",
		required: ["results"],
		properties: {
			results: {
				type: "array",
				items: ref("BulkAddParticipantsResult"),
			},
		},
	});
	ensureSchema(spec, "RoomTranscriptsResponse", {
		type: "object",
		required: ["transcripts", "total", "limit", "offset"],
		properties: {
			transcripts: ref("OpaqueObjectArray"),
			total: { type: "integer" },
			limit: { type: "integer" },
			offset: { type: "integer" },
		},
	});
	ensureSchema(spec, "PublicShareRecording", {
		type: "object",
		required: ["id", "room_id", "room_name", "status"],
		properties: {
			id: { type: "string", format: "uuid" },
			room_id: { type: "string", format: "uuid" },
			room_name: { type: "string" },
			status: { type: "string" },
			started_at: { type: "string", format: "date-time", nullable: true },
			ended_at: { type: "string", format: "date-time", nullable: true },
			duration: { type: "integer", nullable: true },
			size_bytes: { type: "integer", nullable: true },
			download_url: { type: "string", nullable: true },
			metadata: { type: "object", additionalProperties: true, nullable: true },
		},
	});
	ensureSchema(spec, "PublicShareResponse", {
		type: "object",
		required: ["recording", "transcript"],
		properties: {
			recording: ref("PublicShareRecording"),
			transcript: {
				oneOf: [ref("OpaqueObject"), { type: "null" }],
			},
		},
	});
	ensureSchema(spec, "DebugClientIncidentContext", {
		type: "object",
		properties: {
			url: { type: "string" },
			userAgent: { type: "string" },
			online: { type: "boolean" },
			visibilityState: { type: "string" },
		},
	});
	ensureSchema(spec, "DebugSDKIncidentPayload", {
		type: "object",
		required: ["id", "source", "message"],
		properties: {
			id: { type: "string" },
			timestamp: { type: "string" },
			severity: { type: "string" },
			source: { type: "string" },
			message: { type: "string" },
			code: { type: "string" },
			roomId: { type: "string" },
			participantId: { type: "string" },
			traceId: { type: "string" },
			phase: { type: "string" },
			stage: { type: "string" },
			retryable: { type: "boolean" },
			details: { type: "object", additionalProperties: true },
			breadcrumbs: { type: "array", items: {} },
			context: ref("DebugClientIncidentContext"),
		},
	});
	ensureSchema(spec, "DebugClientIncidentRequest", {
		type: "object",
		required: ["incident_id", "source", "message"],
		properties: {
			incident_id: { type: "string" },
			source: { type: "string" },
			stage: { type: "string" },
			severity: { type: "string" },
			message: { type: "string" },
			error_name: { type: "string" },
			error_code: { type: "string" },
			request_url: { type: "string" },
			request_method: { type: "string" },
			session_id: { type: "string" },
			room_id: { type: "string" },
			meeting_url: { type: "string" },
			external_id: { type: "string" },
			user_agent: { type: "string" },
			page_url: { type: "string" },
			online: { type: "boolean" },
			visibility: { type: "string" },
			details: { type: "object", additionalProperties: true },
		},
	});
	ensureSchema(spec, "DebugClientIncidentEnvelope", {
		type: "object",
		required: ["incident"],
		properties: {
			incident: ref("DebugSDKIncidentPayload"),
			reportedAt: { type: "string" },
		},
	});
	ensureSchema(spec, "DebugClientIncidentAcceptedResponse", {
		type: "object",
		required: ["accepted", "incident_id", "request_id"],
		properties: {
			accepted: { type: "boolean" },
			incident_id: { type: "string" },
			request_id: { type: "string" },
		},
	});
	ensureSchema(spec, "AdminOverviewResponse", {
		type: "object",
		required: ["overview", "webhook_stats", "storage_stats"],
		properties: {
			overview: ref("OpaqueObject"),
			webhook_stats: ref("OpaqueObject"),
			storage_stats: ref("OpaqueObjectArray"),
		},
	});
	ensureSchema(spec, "AdminRoomDetailsResponse", {
		type: "object",
		required: ["room", "participants"],
		properties: {
			room: ref("OpaqueObject"),
			participants: ref("OpaqueObjectArray"),
		},
	});
	ensureSchema(spec, "AdminUsageResponse", {
		type: "object",
		required: ["meeting_durations", "storage_by_provider"],
		properties: {
			meeting_durations: ref("OpaqueObject"),
			storage_by_provider: ref("OpaqueObjectArray"),
		},
	});
	ensureSchema(spec, "AdminWhisperJobStatsResponse", {
		type: "object",
		required: ["queued_live", "processing_live", "recorded"],
		properties: {
			queued_live: { type: "integer" },
			processing_live: { type: "integer" },
			recorded: ref("OpaqueObject"),
		},
	});
	ensureSchema(spec, "AdminTenantUpdateRequest", {
		type: "object",
		properties: {
			name: { type: "string" },
			max_concurrent_rooms: { type: "integer" },
			max_participants_per_room: { type: "integer" },
			max_recording_duration_minutes: { type: "integer" },
		},
	});
	ensureSchema(spec, "TenantConfigUpdateRequest", {
		type: "object",
		properties: {
			force_recording: { type: "boolean" },
			auto_start_recording: { type: "boolean" },
			allow_early_join: { type: "boolean" },
			empty_room_timeout_minutes: { type: "integer" },
			recording_retention_days: { type: "integer" },
			duplicate_participant_policy: { type: "string" },
			transcription_enabled: { type: "boolean" },
			transcription_language: { type: "string" },
			transcription_profanity_filter: { type: "boolean" },
			transcription_keywords: { type: "array", items: { type: "string" } },
			allowed_origins: { type: "array", items: { type: "string" } },
			post_meeting_webhook: {
				type: "object",
				properties: {
					enabled: { type: "boolean" },
					url: { type: "string" },
					secret: { type: "string" },
					include_recording: { type: "boolean" },
					include_transcript: { type: "boolean" },
					include_summary: { type: "boolean" },
					include_action_items: { type: "boolean" },
					transcription: {
						type: "object",
						properties: {
							provider: { type: "string" },
							api_key: { type: "string" },
						},
					},
					ai: {
						type: "object",
						properties: {
							provider: { type: "string" },
							api_key: { type: "string" },
							model: { type: "string" },
						},
					},
				},
			},
		},
	});
}

function ensureTagsAndSecurity(spec) {
	ensureTag(spec, "Admin", "Administrative endpoints secured with admin secret.");
	ensureTag(spec, "Ops", "Operational status and incident management endpoints.");
	ensureTag(spec, "Internal", "Internal first-party auth/dashboard endpoints.");
	ensureTag(spec, "Transcription", "Post-meeting transcription endpoints.");
	ensureTag(spec, "WebSocket", "WebSocket handshake endpoint.");
	ensureTag(spec, "WhatsNew", "Release notes endpoints.");

	ensureSecurityScheme(spec, "AdminSecretAuth", {
		type: "apiKey",
		in: "header",
		name: "X-Admin-Secret",
		description: "Admin secret required by /api/v1/admin/* routes.",
	});
	ensureSecurityScheme(spec, "OpsIngestTokenAuth", {
		type: "apiKey",
		in: "header",
		name: "X-Ops-Ingest-Token",
		description: "Ops ingest token required by /api/v1/ops/ingest/* routes.",
	});
}

function enrichOperations(spec) {
	const set = (pathValue, method, operation) => {
		if (!spec.paths?.[pathValue]) {
			throw new Error(`Missing path in spec: ${pathValue}`);
		}
		spec.paths[pathValue][method] = operation;
	};

	const limitParam = queryParam("limit", "Maximum number of items to return", {
		type: "integer",
		minimum: 1,
		maximum: 100,
		default: 50,
	});
	const offsetParam = queryParam("offset", "Number of items to skip", {
		type: "integer",
		minimum: 0,
		default: 0,
	});
	const opsLimitParam = queryParam("limit", "Maximum number of items to return", {
		type: "integer",
		minimum: 1,
		maximum: 200,
		default: 50,
	});

	// Admin + Ops admin
	set("/api/v1/admin/overview", "get", op({
		summary: "Get Admin Overview",
		tags: ["Admin"],
		security: [{ AdminSecretAuth: [] }],
		responses: {
			"200": { description: "Admin overview", content: jsonContent(ref("AdminOverviewResponse")) },
			"500": errorResponse,
		},
	}));
	set("/api/v1/admin/audit-logs", "get", op({
		summary: "List Audit Logs",
		tags: ["Admin"],
		security: [{ AdminSecretAuth: [] }],
		parameters: [limitParam, offsetParam],
		responses: {
			"200": { description: "Audit logs", content: jsonContent(ref("OpaqueObjectArray")) },
			"500": errorResponse,
		},
	}));
	set("/api/v1/admin/recordings", "get", op({
		summary: "List Recordings",
		tags: ["Admin", "Recordings"],
		security: [{ AdminSecretAuth: [] }],
		parameters: [limitParam, offsetParam],
		responses: {
			"200": { description: "Recordings", content: jsonContent(ref("OpaqueObjectArray")) },
			"500": errorResponse,
		},
	}));
	set("/api/v1/admin/rooms", "get", op({
		summary: "List Rooms",
		tags: ["Admin", "Rooms"],
		security: [{ AdminSecretAuth: [] }],
		parameters: [limitParam, offsetParam],
		responses: {
			"200": { description: "Rooms", content: jsonContent(ref("OpaqueObjectArray")) },
			"500": errorResponse,
		},
	}));
	set("/api/v1/admin/rooms/{id}", "get", op({
		summary: "Get Room Details",
		tags: ["Admin", "Rooms"],
		security: [{ AdminSecretAuth: [] }],
		parameters: [pathParam("id", "Room UUID", { type: "string", format: "uuid" })],
		responses: {
			"200": { description: "Room details", content: jsonContent(ref("AdminRoomDetailsResponse")) },
			"400": errorResponse,
			"404": errorResponse,
			"500": errorResponse,
		},
	}));
	set("/api/v1/admin/tenants", "get", op({
		summary: "List Tenants",
		tags: ["Admin", "Tenants"],
		security: [{ AdminSecretAuth: [] }],
		parameters: [limitParam, offsetParam],
		responses: {
			"200": { description: "Tenants", content: jsonContent(ref("OpaqueObjectArray")) },
			"500": errorResponse,
		},
	}));
	set("/api/v1/admin/tenants", "post", op({
		summary: "Create Tenant",
		tags: ["Admin", "Tenants"],
		security: [{ AdminSecretAuth: [] }],
		requestBody: {
			required: true,
			content: jsonContent(ref("CreateTenantRequest")),
		},
		responses: {
			"201": { description: "Tenant created", content: jsonContent(ref("CreateTenantResponse")) },
			"400": errorResponse,
			"500": errorResponse,
		},
	}));
	set("/api/v1/admin/tenants/{id}", "get", op({
		summary: "Get Tenant",
		tags: ["Admin", "Tenants"],
		security: [{ AdminSecretAuth: [] }],
		parameters: [pathParam("id", "Tenant UUID", { type: "string", format: "uuid" })],
		responses: {
			"200": { description: "Tenant", content: jsonContent(ref("Tenant")) },
			"400": errorResponse,
			"404": errorResponse,
		},
	}));
	set("/api/v1/admin/tenants/{id}", "patch", op({
		summary: "Update Tenant",
		tags: ["Admin", "Tenants"],
		security: [{ AdminSecretAuth: [] }],
		parameters: [pathParam("id", "Tenant UUID", { type: "string", format: "uuid" })],
		requestBody: {
			required: true,
			content: jsonContent(ref("AdminTenantUpdateRequest")),
		},
		responses: {
			"200": { description: "Tenant updated", content: jsonContent(ref("Tenant")) },
			"400": errorResponse,
			"500": errorResponse,
		},
	}));
	set("/api/v1/admin/tenants/{id}", "delete", op({
		summary: "Delete Tenant",
		tags: ["Admin", "Tenants"],
		security: [{ AdminSecretAuth: [] }],
		parameters: [pathParam("id", "Tenant UUID", { type: "string", format: "uuid" })],
		responses: {
			"204": { description: "Tenant deleted" },
			"400": errorResponse,
			"500": errorResponse,
		},
	}));
	set("/api/v1/admin/tenants/{id}/activate", "patch", op({
		summary: "Activate Tenant",
		tags: ["Admin", "Tenants"],
		security: [{ AdminSecretAuth: [] }],
		parameters: [pathParam("id", "Tenant UUID", { type: "string", format: "uuid" })],
		responses: {
			"200": { description: "Tenant activated", content: jsonContent(ref("Tenant")) },
			"400": errorResponse,
			"500": errorResponse,
		},
	}));
	set("/api/v1/admin/tenants/{id}/config", "patch", op({
		summary: "Update Tenant Config",
		tags: ["Admin", "Tenants"],
		security: [{ AdminSecretAuth: [] }],
		parameters: [pathParam("id", "Tenant UUID", { type: "string", format: "uuid" })],
		requestBody: {
			required: true,
			content: jsonContent({ type: "object", additionalProperties: true }),
		},
		responses: {
			"200": { description: "Tenant updated", content: jsonContent(ref("Tenant")) },
			"400": errorResponse,
			"500": errorResponse,
		},
	}));
	set("/api/v1/admin/tenants/{id}/deactivate", "patch", op({
		summary: "Deactivate Tenant",
		tags: ["Admin", "Tenants"],
		security: [{ AdminSecretAuth: [] }],
		parameters: [pathParam("id", "Tenant UUID", { type: "string", format: "uuid" })],
		responses: {
			"200": { description: "Tenant deactivated", content: jsonContent(ref("Tenant")) },
			"400": errorResponse,
			"500": errorResponse,
		},
	}));
	set("/api/v1/admin/tenants/{id}/rotate-key", "post", op({
		summary: "Rotate Tenant API Key",
		tags: ["Admin", "Tenants", "Auth"],
		security: [{ AdminSecretAuth: [] }],
		parameters: [pathParam("id", "Tenant UUID", { type: "string", format: "uuid" })],
		responses: {
			"200": { description: "Key rotated", content: jsonContent(ref("RotateApiKeyResponse")) },
			"400": errorResponse,
			"500": errorResponse,
		},
	}));
	set("/api/v1/admin/tenants/{id}/whiteboard-config", "patch", op({
		summary: "Update Tenant Whiteboard Config",
		tags: ["Admin", "Tenants"],
		security: [{ AdminSecretAuth: [] }],
		parameters: [pathParam("id", "Tenant UUID", { type: "string", format: "uuid" })],
		requestBody: {
			required: true,
			content: jsonContent({ type: "object", additionalProperties: true }),
		},
		responses: {
			"200": { description: "Whiteboard config updated", content: jsonContent(ref("Tenant")) },
			"400": errorResponse,
			"500": errorResponse,
		},
	}));
	set("/api/v1/admin/transcripts", "get", op({
		summary: "List Transcripts",
		tags: ["Admin", "Transcription"],
		security: [{ AdminSecretAuth: [] }],
		parameters: [limitParam, offsetParam],
		responses: {
			"200": { description: "Transcripts", content: jsonContent(ref("OpaqueObjectArray")) },
			"500": errorResponse,
		},
	}));
	set("/api/v1/admin/usage", "get", op({
		summary: "Get Usage Summary",
		tags: ["Admin"],
		security: [{ AdminSecretAuth: [] }],
		responses: {
			"200": { description: "Usage summary", content: jsonContent(ref("AdminUsageResponse")) },
			"500": errorResponse,
		},
	}));
	set("/api/v1/admin/webhooks", "get", op({
		summary: "List Webhook Deliveries",
		tags: ["Admin", "Webhooks"],
		security: [{ AdminSecretAuth: [] }],
		parameters: [limitParam, offsetParam],
		responses: {
			"200": { description: "Webhook deliveries", content: jsonContent(ref("OpaqueObjectArray")) },
			"500": errorResponse,
		},
	}));
	set("/api/v1/admin/whisper-jobs", "get", op({
		summary: "List Whisper Jobs",
		tags: ["Admin", "Transcription"],
		security: [{ AdminSecretAuth: [] }],
		parameters: [limitParam, offsetParam],
		responses: {
			"200": { description: "Whisper jobs", content: jsonContent(ref("OpaqueObjectArray")) },
			"500": errorResponse,
		},
	}));
	set("/api/v1/admin/whisper-jobs/processing", "get", op({
		summary: "List Processing Whisper Jobs",
		tags: ["Admin", "Transcription"],
		security: [{ AdminSecretAuth: [] }],
		responses: {
			"200": { description: "Processing whisper jobs", content: jsonContent(ref("OpaqueObjectArray")) },
			"500": errorResponse,
		},
	}));
	set("/api/v1/admin/whisper-jobs/stats", "get", op({
		summary: "Get Whisper Job Stats",
		tags: ["Admin", "Transcription"],
		security: [{ AdminSecretAuth: [] }],
		responses: {
			"200": { description: "Whisper job stats", content: jsonContent(ref("AdminWhisperJobStatsResponse")) },
			"500": errorResponse,
		},
	}));
	set("/api/v1/admin/ops/overview", "get", op({
		summary: "Get Ops Overview",
		tags: ["Admin", "Ops"],
		security: [{ AdminSecretAuth: [] }],
		responses: {
			"200": { description: "Ops overview", content: jsonContent(ref("OpaqueObject")) },
			"500": errorResponse,
		},
	}));
	set("/api/v1/admin/ops/incidents", "get", op({
		summary: "List Ops Incidents",
		tags: ["Admin", "Ops"],
		security: [{ AdminSecretAuth: [] }],
		parameters: [opsLimitParam, offsetParam],
		responses: {
			"200": { description: "Incidents", content: jsonContent(ref("OpaqueObjectArray")) },
			"500": errorResponse,
		},
	}));
	set("/api/v1/admin/ops/incidents/{incidentCode}", "get", op({
		summary: "Get Ops Incident",
		tags: ["Admin", "Ops"],
		security: [{ AdminSecretAuth: [] }],
		parameters: [pathParam("incidentCode", "Incident code")],
		responses: {
			"200": { description: "Incident", content: jsonContent(ref("OpaqueObject")) },
			"404": errorResponse,
		},
	}));
	set("/api/v1/admin/ops/incidents/declare", "post", op({
		summary: "Declare Ops Incident",
		tags: ["Admin", "Ops"],
		security: [{ AdminSecretAuth: [] }],
		requestBody: {
			required: true,
			content: jsonContent(ref("OpsDeclareIncidentRequest")),
		},
		responses: {
			"201": { description: "Incident declared", content: jsonContent(ref("OpaqueObject")) },
			"400": errorResponse,
		},
	}));
	set("/api/v1/admin/ops/incidents/{incidentCode}/events", "post", op({
		summary: "Add Ops Incident Event",
		tags: ["Admin", "Ops"],
		security: [{ AdminSecretAuth: [] }],
		parameters: [pathParam("incidentCode", "Incident code")],
		requestBody: {
			required: true,
			content: jsonContent(ref("OpsAddIncidentEventRequest")),
		},
		responses: {
			"200": { description: "Incident event added", content: jsonContent(ref("OpaqueObject")) },
			"400": errorResponse,
		},
	}));
	set("/api/v1/admin/ops/incidents/{incidentCode}/publish", "post", op({
		summary: "Publish Ops Incident",
		tags: ["Admin", "Ops"],
		security: [{ AdminSecretAuth: [] }],
		parameters: [pathParam("incidentCode", "Incident code")],
		requestBody: {
			required: false,
			content: jsonContent(ref("OpsPublishIncidentRequest")),
		},
		responses: {
			"200": { description: "Incident published", content: jsonContent(ref("OpaqueObject")) },
			"400": errorResponse,
		},
	}));
	set("/api/v1/admin/ops/incidents/{incidentCode}/resolve", "post", op({
		summary: "Resolve Ops Incident",
		tags: ["Admin", "Ops"],
		security: [{ AdminSecretAuth: [] }],
		parameters: [pathParam("incidentCode", "Incident code")],
		requestBody: {
			required: false,
			content: jsonContent(ref("OpsResolveIncidentRequest")),
		},
		responses: {
			"200": { description: "Incident resolved", content: jsonContent(ref("OpaqueObject")) },
			"400": errorResponse,
		},
	}));
	set("/api/v1/admin/ops/incidents/{incidentCode}/ai-drafts", "post", op({
		summary: "Generate Ops Incident AI Drafts",
		tags: ["Admin", "Ops"],
		security: [{ AdminSecretAuth: [] }],
		parameters: [pathParam("incidentCode", "Incident code")],
		responses: {
			"200": { description: "AI drafts", content: jsonContent(ref("OpaqueObject")) },
			"400": errorResponse,
		},
	}));
	set("/api/v1/admin/ops/maintenance", "post", op({
		summary: "Create Maintenance Window",
		tags: ["Admin", "Ops"],
		security: [{ AdminSecretAuth: [] }],
		requestBody: {
			required: true,
			content: jsonContent(ref("OpsMaintenanceRequest")),
		},
		responses: {
			"201": { description: "Maintenance window created", content: jsonContent(ref("OpaqueObject")) },
			"400": errorResponse,
		},
	}));
	set("/api/v1/admin/ops/maintenance/{id}/cancel", "post", op({
		summary: "Cancel Maintenance Window",
		tags: ["Admin", "Ops"],
		security: [{ AdminSecretAuth: [] }],
		parameters: [pathParam("id", "Maintenance window UUID", { type: "string", format: "uuid" })],
		responses: {
			"200": { description: "Maintenance window canceled", content: jsonContent(ref("OpaqueObject")) },
			"400": errorResponse,
			"404": errorResponse,
		},
	}));

	// Debug
	set("/api/v1/debug/client-incident", "post", op({
		summary: "Report Client Incident",
		tags: ["Debug"],
		security: [{ ApiKeyAuth: [] }],
		requestBody: {
			required: true,
			content: jsonContent({
				oneOf: [ref("DebugClientIncidentRequest"), ref("DebugClientIncidentEnvelope")],
			}),
		},
		responses: {
			"202": { description: "Incident accepted", content: jsonContent(ref("DebugClientIncidentAcceptedResponse")) },
			"400": errorResponse,
			"401": errorResponse,
			"500": errorResponse,
		},
	}));

	// Internal auth + meetings
	set("/api/v1/internal/auth/google", "post", op({
		summary: "Exchange Google OAuth Code",
		tags: ["Internal", "Auth"],
		security: [],
		requestBody: {
			required: true,
			content: jsonContent(ref("InternalAuthGoogleRequest")),
		},
		responses: {
			"200": { description: "Session established", content: jsonContent(ref("InternalAuthGoogleResponse")) },
			"400": errorResponse,
			"401": errorResponse,
			"500": errorResponse,
			"503": errorResponse,
		},
	}));
	set("/api/v1/internal/auth/session", "get", op({
		summary: "Get Internal Session",
		tags: ["Internal", "Auth"],
		security: [],
		responses: {
			"200": { description: "Current session", content: jsonContent(ref("InternalAuthSessionResponse")) },
			"401": errorResponse,
		},
	}));
	set("/api/v1/internal/auth/logout", "post", op({
		summary: "Logout Internal Session",
		tags: ["Internal", "Auth"],
		security: [],
		responses: {
			"200": { description: "Logged out", content: jsonContent(ref("InternalAuthLogoutResponse")) },
		},
	}));
	set("/api/v1/internal/auth/access-token", "get", op({
		summary: "Get Internal Access Token",
		tags: ["Internal", "Auth"],
		security: [],
		parameters: [
			{
				name: "X-Chalk-Local-Client-ID",
				in: "header",
				required: false,
				description: "Optional local client id used in local dashboard bootstrap.",
				schema: { type: "string" },
			},
		],
		responses: {
			"200": { description: "Access token", content: jsonContent(ref("InternalAuthAccessTokenResponse")) },
			"500": errorResponse,
		},
	}));
	set("/api/v1/internal/meetings", "get", op({
		summary: "List Internal Meetings",
		tags: ["Internal"],
		security: [{ BearerAuth: [] }],
		parameters: [
			queryParam("limit", "Maximum number of meetings", { type: "integer", default: 50, minimum: 1 }),
			queryParam("offset", "Number of meetings to skip", { type: "integer", default: 0, minimum: 0 }),
		],
		responses: {
			"200": { description: "Meetings list", content: jsonContent(ref("InternalMeetingsResponse")) },
			"401": errorResponse,
			"403": errorResponse,
			"404": errorResponse,
			"500": errorResponse,
		},
	}));

	// Ops ingest + status public
	set("/api/v1/ops/ingest/monitor-results", "post", op({
		summary: "Ingest Monitor Result",
		tags: ["Ops"],
		security: [{ OpsIngestTokenAuth: [] }],
		requestBody: {
			required: true,
			content: jsonContent(ref("OpsIngestMonitorResultRequest")),
		},
		responses: {
			"202": { description: "Monitor result ingested", content: jsonContent(ref("OpsIngestMonitorResultResponse")) },
			"400": errorResponse,
			"401": errorResponse,
			"500": errorResponse,
		},
	}));
	set("/api/v1/ops/ingest/heartbeats", "post", op({
		summary: "Ingest Heartbeat Event",
		tags: ["Ops"],
		security: [{ OpsIngestTokenAuth: [] }],
		requestBody: {
			required: true,
			content: jsonContent(ref("OpsIngestHeartbeatRequest")),
		},
		responses: {
			"202": { description: "Heartbeat ingested", content: jsonContent(ref("OpsIngestHeartbeatResponse")) },
			"400": errorResponse,
			"401": errorResponse,
			"500": errorResponse,
		},
	}));
	set("/api/v1/status", "get", op({
		summary: "Get Public Status Summary",
		tags: ["Ops"],
		security: [],
		responses: {
			"200": { description: "Public status summary", content: jsonContent(ref("OpsStatusSummaryResponse")) },
			"500": errorResponse,
		},
	}));
	set("/api/v1/status/card.png", "get", op({
		summary: "Get Public Status Card PNG",
		description: "Returns a generated PNG image for embedding the current public service status.",
		tags: ["Ops"],
		security: [],
		responses: {
			"200": { description: "Public status card image", content: pngContent },
			"500": errorResponse,
		},
	}));
	set("/api/v1/status/incidents/{incidentCode}", "get", op({
		summary: "Get Public Incident Details",
		tags: ["Ops"],
		security: [],
		parameters: [pathParam("incidentCode", "Incident code")],
		responses: {
			"200": { description: "Incident details", content: jsonContent(ref("OpsIncidentDetailsResponse")) },
			"404": errorResponse,
		},
	}));

	// Public/share + what's new
	set("/api/v1/public/share/{token}", "get", op({
		summary: "Get Public Recording Share",
		tags: ["Recordings"],
		security: [],
		parameters: [pathParam("token", "Signed public share token")],
		responses: {
			"200": { description: "Shared recording payload", content: jsonContent(ref("PublicShareResponse")) },
			"404": errorResponse,
		},
	}));
	set("/api/v1/whats-new", "get", op({
		summary: "Get Latest Release Notes",
		tags: ["WhatsNew"],
		security: [],
		responses: {
			"200": { description: "Latest release notes", content: jsonContent(ref("WhatsNewResponse")) },
			"404": errorResponse,
			"502": errorResponse,
		},
	}));
	set("/api/v1/whats-new/releases", "get", op({
		summary: "List Release Notes",
		tags: ["WhatsNew"],
		security: [],
		responses: {
			"200": { description: "Release notes", content: jsonContent(ref("WhatsNewReleasesResponse")) },
			"404": errorResponse,
			"502": errorResponse,
		},
	}));

	// Recordings + transcripts
	set("/api/v1/recordings/{id}/recover", "post", op({
		summary: "Recover Recording from Cloudflare",
		tags: ["Recordings"],
		security: [{ BearerAuth: [] }],
		parameters: [pathParam("id", "Recording UUID", { type: "string", format: "uuid" })],
		responses: {
			"200": { description: "Recovery result", content: jsonContent(ref("RecordingRecoverResponse")) },
			"400": errorResponse,
			"401": errorResponse,
			"404": errorResponse,
			"502": errorResponse,
			"500": errorResponse,
		},
	}));
	set("/api/v1/recordings/{id}/share", "post", op({
		summary: "Create Recording Share Token",
		description: "Requires host role in addition to recording permissions.",
		tags: ["Recordings"],
		security: [{ BearerAuth: [] }],
		parameters: [pathParam("id", "Recording UUID", { type: "string", format: "uuid" })],
		responses: {
			"200": { description: "Share token", content: jsonContent(ref("RecordingShareTokenResponse")) },
			"400": errorResponse,
			"401": errorResponse,
			"404": errorResponse,
			"500": errorResponse,
		},
	}));
	set("/api/v1/recordings/{id}/transcribe", "post", op({
		summary: "Queue Post-Meeting Transcription",
		tags: ["Transcription", "Recordings"],
		security: [{ BearerAuth: [] }],
		parameters: [pathParam("id", "Recording UUID", { type: "string", format: "uuid" })],
		requestBody: {
			required: true,
			content: jsonContent(ref("QueueTranscriptionRequest")),
		},
		responses: {
			"202": { description: "Transcription queued", content: jsonContent(ref("QueueTranscriptionResponse")) },
			"400": errorResponse,
			"401": errorResponse,
			"500": errorResponse,
		},
	}));
	set("/api/v1/recordings/{id}/transcript", "get", op({
		summary: "Get Post-Meeting Transcript by Recording",
		tags: ["Transcription", "Recordings"],
		security: [{ BearerAuth: [] }],
		parameters: [pathParam("id", "Recording UUID", { type: "string", format: "uuid" })],
		responses: {
			"200": { description: "Transcript", content: jsonContent(ref("OpaqueObject")) },
			"400": errorResponse,
			"404": errorResponse,
		},
	}));
	set("/api/v1/rooms/{id}/participants/bulk", "post", op({
		summary: "Bulk Add Participants",
		description: "Requires host role.",
		tags: ["Participants"],
		security: [{ BearerAuth: [] }],
		parameters: [pathParam("id", "Room UUID or slug")],
		requestBody: {
			required: true,
			content: jsonContent(ref("BulkAddParticipantsRequest")),
		},
		responses: {
			"200": { description: "Bulk add results", content: jsonContent(ref("BulkAddParticipantsResponse")) },
			"400": errorResponse,
			"401": errorResponse,
			"404": errorResponse,
		},
	}));
	set("/api/v1/rooms/{id}/recordings/sync", "post", op({
		summary: "Sync Room Recordings from Cloudflare",
		description: "Requires host role.",
		tags: ["Recordings", "Rooms"],
		security: [{ BearerAuth: [] }],
		parameters: [pathParam("id", "Room UUID", { type: "string", format: "uuid" })],
		responses: {
			"200": { description: "Sync result", content: jsonContent(ref("RecordingSyncResponse")) },
			"400": errorResponse,
			"401": errorResponse,
			"404": errorResponse,
			"500": errorResponse,
		},
	}));
	set("/api/v1/rooms/{id}/transcripts", "get", op({
		summary: "List Room Transcripts",
		tags: ["Transcription", "Rooms"],
		security: [{ BearerAuth: [] }],
		parameters: [
			pathParam("id", "Room UUID", { type: "string", format: "uuid" }),
			queryParam("limit", "Maximum number of transcripts", { type: "integer", default: 100, minimum: 1, maximum: 1000 }),
			queryParam("offset", "Number of transcripts to skip", { type: "integer", default: 0, minimum: 0 }),
		],
		responses: {
			"200": { description: "Room transcripts", content: jsonContent(ref("RoomTranscriptsResponse")) },
			"400": errorResponse,
			"401": errorResponse,
			"404": errorResponse,
			"500": errorResponse,
		},
	}));

	// Tenant config (API key)
	set("/api/v1/tenants/{id}/config", "patch", op({
		summary: "Update Tenant Runtime Config",
		tags: ["Tenants"],
		security: [{ ApiKeyAuth: [] }],
		parameters: [pathParam("id", "Tenant UUID", { type: "string", format: "uuid" })],
		requestBody: {
			required: true,
			content: jsonContent(ref("TenantConfigUpdateRequest")),
		},
		responses: {
			"200": { description: "Updated tenant", content: jsonContent(ref("Tenant")) },
			"400": errorResponse,
			"403": errorResponse,
			"404": errorResponse,
			"500": errorResponse,
		},
	}));

	// Transcription
	set("/api/v1/transcription/providers", "get", op({
		summary: "List Available Transcription Providers",
		tags: ["Transcription"],
		security: [],
		responses: {
			"200": { description: "Provider list", content: jsonContent(ref("TranscriptionProvidersResponse")) },
		},
	}));
	set("/api/v1/transcription/providers/cloudflare/callback", "post", op({
		summary: "Handle Cloudflare Transcription Callback",
		tags: ["Transcription"],
		security: [],
		requestBody: {
			required: true,
			content: jsonContent(ref("OpaqueObject")),
		},
		responses: {
			"200": { description: "Callback accepted", content: jsonContent(ref("TranscriptionCallbackResponse")) },
			"400": errorResponse,
			"401": errorResponse,
			"503": errorResponse,
		},
	}));
	set("/api/v1/transcription/{id}", "get", op({
		summary: "Get Post-Meeting Transcript",
		tags: ["Transcription"],
		security: [{ BearerAuth: [] }],
		parameters: [pathParam("id", "Transcript UUID", { type: "string", format: "uuid" })],
		responses: {
			"200": { description: "Transcript", content: jsonContent(ref("OpaqueObject")) },
			"400": errorResponse,
			"401": errorResponse,
			"404": errorResponse,
		},
	}));

	// WebSocket handshake
	set("/ws", "get", op({
		summary: "Upgrade to WebSocket",
		description:
			"WebSocket handshake endpoint. JWT token is provided via Sec-WebSocket-Protocol as token.<jwt> (preferred) or query param fallback.",
		tags: ["WebSocket"],
		security: [],
		parameters: [
			queryParam("token", "JWT token fallback for clients unable to set subprotocol token", { type: "string" }),
			queryParam("room", "Optional room identifier for diagnostics", { type: "string" }),
		],
		responses: {
			"101": { description: "Switching Protocols" },
			"400": errorResponse,
			"401": errorResponse,
			"403": errorResponse,
		},
	}));
}

function countStubs(spec) {
	let stubs = 0;
	for (const pathItem of Object.values(spec.paths ?? {})) {
		for (const [method, operation] of Object.entries(pathItem ?? {})) {
			if (!METHODS.has(method.toLowerCase())) continue;
			if (operation?.["x-generated-stub"] === true) {
				stubs += 1;
			}
		}
	}
	return stubs;
}

function main() {
	const source = fs.readFileSync(openapiPath, "utf8");
	const spec = YAML.parse(source, { maxAliasCount: -1 });

	ensureTagsAndSecurity(spec);
	ensureSchemas(spec);
	enrichOperations(spec);

	const before = countStubs(YAML.parse(source, { maxAliasCount: -1 }));
	const after = countStubs(spec);
	if (before > 0 && after >= before) {
		throw new Error(`Enrichment failed to reduce stubs. before=${before}, after=${after}`);
	}

	const out = YAML.stringify(spec, { lineWidth: 0, aliasDuplicateObjects: false });
	fs.writeFileSync(openapiPath, out);
	console.log(`Enriched openapi contracts. stubs before=${before}, after=${after}`);
}

main();
