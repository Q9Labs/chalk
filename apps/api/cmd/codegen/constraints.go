package main

import (
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/problemreports"
	"github.com/q9labs/chalk/apps/api/internal/recordings"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/webhooks"
)

func applyFieldConstraints(schema map[string]any, schemaName string, fieldName string, request bool) map[string]any {
	constrainEventTypes(schema, fieldName)
	if enum := fieldEnum(schemaName, fieldName); len(enum) > 0 {
		schema["enum"] = enum
	}
	constrainUUID(schema, schemaName, fieldName)
	switch schemaName {
	case "ConnectionReportRequest":
		constrainConnectionReport(schema, fieldName)
	case "CallStatsRequest":
		constrainCallStats(schema, fieldName)
	case "ProblemReportRequest":
		constrainProblemReport(schema, fieldName)
	case "UpdateTenantRequest":
		constrainTenantUpdate(schema, fieldName)
	}
	if request && fieldName == "name" && (schemaName == "CreateSpaceRequest" || schemaName == "UpdateSpaceRequest") {
		schema["maxLength"] = spaces.MaxNameCodePoints
		schema[lengthUnitExtension] = codePointLengthUnit
	}
	constrainByFieldName(schema, fieldName)
	if request && schemaTypeIs(schema, "string") && !schemaIncludesNull(schema) && len(fieldEnum(schemaName, fieldName)) == 0 && !requestFieldAllowsEmpty(schemaName, fieldName) {
		schema["minLength"] = 1
	}
	constrainArrayItems(schema, fieldName)
	return schema
}

func constrainUUID(schema map[string]any, schemaName string, fieldName string) {
	if !isUUIDField(fieldName) || isOpaqueIDField(schemaName, fieldName) {
		return
	}
	schema["format"] = "uuid"
	schema["minLength"] = 36
	schema["maxLength"] = 36
}

func constrainEventTypes(schema map[string]any, fieldName string) {
	if fieldName != "event_types" || !schemaTypeIs(schema, "array") {
		return
	}
	if items, ok := schema["items"].(map[string]any); ok {
		items["enum"] = webhooks.SubscribableEventTypes()
	}
}

func constrainConnectionReport(schema map[string]any, fieldName string) {
	switch fieldName {
	case "version":
		schema["enum"] = []int{1}
	case "events":
		schema["minItems"] = 1
		schema["maxItems"] = httpapi.ConnectionReportEventLimit
	case "elapsed_ms", "attempt", "duration_ms", "heartbeat_gap_ms":
		schema["minimum"] = 0
		schema["maximum"] = httpapi.ConnectionReportMaxMilliseconds
	case "close_code":
		schema["minimum"] = 1000
		schema["maximum"] = 4999
	case "http_status":
		schema["minimum"] = 400
		schema["maximum"] = 599
	case "announced", "pull_requested", "pull_failed", "pull_succeeded", "track_received", "bytes_flowing", "element_bound", "playing", "projection_off", "receivers_stopped":
		schema["minimum"] = 0
		schema["maximum"] = httpapi.ConnectionReportMaxReceiveCount
	}
}

func constrainCallStats(schema map[string]any, fieldName string) {
	switch fieldName {
	case "version":
		schema["enum"] = []int{1}
	case "samples":
		schema["minItems"] = 1
		schema["maxItems"] = httpapi.CallStatsSampleLimit
	case "elapsed_ms":
		schema["minimum"] = 0
		schema["maximum"] = httpapi.CallStatsMaxElapsedMS
	case "window_ms":
		schema["minimum"] = httpapi.CallStatsMinWindowMS
		schema["maximum"] = httpapi.CallStatsMaxWindowMS
	default:
		if maximum := httpapi.CallStatsMaximum(fieldName); maximum > 0 {
			schema["minimum"] = 0
			schema["maximum"] = maximum
		}
	}
}

func constrainProblemReport(schema map[string]any, fieldName string) {
	switch fieldName {
	case "description":
		schema["maxLength"] = problemreports.MaxDescriptionCodePoints
		// Match Go strings.TrimSpace, including NEL (not JS \s) and excluding BOM.
		schema["pattern"] = `[^\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]`
	case "diagnostics":
		schema["maxLength"] = problemreports.MaxDiagnosticsCodePoints
	}
	schema[lengthUnitExtension] = codePointLengthUnit
}

func constrainTenantUpdate(schema map[string]any, fieldName string) {
	switch fieldName {
	case "recording_retention_seconds", "transcript_retention_seconds":
		schema["minimum"] = 0
		schema["maximum"] = artifactpolicy.MaximumRetentionSeconds
	case "transcription_source_window_seconds":
		schema["minimum"] = 0
		schema["maximum"] = int64(artifactpolicy.MaximumSourceWindow / time.Second)
	}
}

// constrainByFieldName applies the constraints that follow a field's name in every schema.
func constrainByFieldName(schema map[string]any, fieldName string) {
	switch {
	case fieldName == "external_id":
		schema["minLength"] = 1
		schema["maxLength"] = 512
		schema[lengthUnitExtension] = codePointLengthUnit
	case fieldName == "identity_external_id":
		schema["minLength"] = 1
		schema["maxLength"] = 256
	case fieldName == "email":
		schema["format"] = "email"
	case fieldName == "website" || strings.HasSuffix(fieldName, "_url"):
		schema["format"] = "uri"
	}
}

func constrainArrayItems(schema map[string]any, fieldName string) {
	if !schemaTypeIs(schema, "array") {
		return
	}
	items, hasItems := schema["items"].(map[string]any)
	switch fieldName {
	case "languages":
		// An empty list means the provider detects the language, so neither a
		// request nor the Transcript it creates may require a minimum length.
		if hasItems {
			items["minLength"] = 1
		}
	case "cors_allowed_origins":
		schema["maxItems"] = tenants.MaxCORSOrigins
		if hasItems {
			items["format"] = "uri"
			items["maxLength"] = tenants.MaxCORSOriginBytes
			items["pattern"] = tenants.CORSOriginPattern
		}
	}
}

func requestFieldAllowsEmpty(schemaName string, fieldName string) bool {
	return (schemaName == "RequestTranscriptRequest" && fieldName == "language") ||
		(schemaName == "ProblemReportRequest" && fieldName == "diagnostics")
}

func fieldEnum(schemaName string, fieldName string) []string {
	switch schemaName {
	case "ConnectionReportRequest":
		return httpapi.ConnectionReportFieldEnum(fieldName)
	case "CallStatsRequest":
		return httpapi.CallStatsFieldEnum(fieldName)
	case "CloudflareSFUSignalRequest":
		if values := httpapi.SFUSignalFieldEnum(fieldName); values != nil {
			return values
		}
	case "SFUSubscriptionsResponse":
		switch fieldName {
		case "state":
			return []string{mediaplane.SubscriptionActive, mediaplane.SubscriptionPaused}
		case "reason":
			return []string{mediaplane.PauseCongestion, mediaplane.PauseViewer, mediaplane.PauseSourceInactive, mediaplane.PauseSourceUnauthorized}
		}
	}
	switch fieldName {
	case "transcript_language":
		return artifactpolicy.TranscriptLanguageValues()
	case "recording_render_mode":
		return []string{"on_demand", "automatic"}
	case "admission":
		if schemaName == "AdmitEpisodeParticipantRequest" {
			return []string{string(episodes.AdmissionPolicy), string(episodes.AdmissionDirect)}
		}
	case "role":
		// Episode participant roles are customer-defined space roles, so only
		// Membership schemas list values and the rest stay open strings.
		switch schemaName {
		case "Membership", "MembershipList", "CreateMembershipRequest", "UpdateMembershipRequest":
			return []string{"owner", "collaborator", "observer"}
		}
	case "storage_provider":
		return []string{"r2"}
	case "status":
		return statusEnum(schemaName)
	}
	return nil
}

func statusEnum(schemaName string) []string {
	switch schemaName {
	case "Episode", "EpisodeList", "CreateEpisodeRequest", "UpdateEpisodeRequest", "ParticipantEpisodeStatus":
		return []string{"active", "ending", "ended"}
	case "Recording", "RecordingList", "CreateRecordingRequest", "UpdateRecordingRequest":
		return []string{recordings.StatusPending, recordings.StatusProcessing, recordings.StatusCompleted, recordings.StatusFailed}
	case "Transcript", "TranscriptList", "CreateTranscriptRequest", "UpdateTranscriptRequest":
		return []string{
			transcripts.StatusNotRequested, transcripts.StatusPreparing, transcripts.StatusTranscribing, transcripts.StatusVerifying,
			transcripts.StatusComplete, transcripts.StatusRetryableFailure, transcripts.StatusTerminalFailure, transcripts.StatusDeleted,
			transcripts.StatusPending, transcripts.StatusProcessing, transcripts.StatusCompleted, transcripts.StatusFailed,
		}
	}
	return nil
}
