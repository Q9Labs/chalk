package main

import "strings"

func idSchemaNames() []string {
	return []string{
		"AuditLogId",
		"EpisodeId",
		"MembershipId",
		"ParticipantId",
		"RecordingId",
		"SpaceId",
		"TenantId",
		"TranscriptId",
		"UserId",
	}
}

func idSchemaName(schemaName string, fieldName string) (string, bool) {
	if isOpaqueIDField(schemaName, fieldName) {
		return "", false
	}
	if fieldName == "id" {
		switch schemaName {
		case "AuditLog":
			return "AuditLogId", true
		case "AuthUser", "User":
			return "UserId", true
		case "Membership":
			return "MembershipId", true
		case "Recording":
			return "RecordingId", true
		case "Space":
			return "SpaceId", true
		case "Episode":
			return "EpisodeId", true
		case "Participant", "ParticipantLifecycle":
			return "ParticipantId", true
		case "Tenant":
			return "TenantId", true
		case "Transcript":
			return "TranscriptId", true
		default:
			return "UUID", true
		}
	}

	if name, ok := exactIDSchemaName(fieldName); ok {
		return name, true
	}
	if name, ok := suffixIDSchemaName(fieldName); ok {
		return name, true
	}
	if isUUIDField(fieldName) {
		return "UUID", true
	}
	return "", false
}

func exactIDSchemaName(fieldName string) (string, bool) {
	switch fieldName {
	case "audit_log_id":
		return "AuditLogId", true
	case "membership_id":
		return "MembershipId", true
	case "recording_id":
		return "RecordingId", true
	case "episode_id":
		return "EpisodeId", true
	case "participant_id", "participant_episode_id":
		return "ParticipantId", true
	case "space_id":
		return "SpaceId", true
	case "tenant_id":
		return "TenantId", true
	case "transcript_id":
		return "TranscriptId", true
	case "actor_user_id", "user_id":
		return "UserId", true
	default:
		return "", false
	}
}

func suffixIDSchemaName(fieldName string) (string, bool) {
	suffixes := []struct {
		suffix string
		name   string
	}{
		{"_audit_log_id", "AuditLogId"},
		{"_participant_episode_id", "ParticipantId"},
		{"_episode_id", "EpisodeId"},
		{"_membership_id", "MembershipId"},
		{"_participant_id", "ParticipantId"},
		{"_recording_id", "RecordingId"},
		{"_space_id", "SpaceId"},
		{"_tenant_id", "TenantId"},
		{"_transcript_id", "TranscriptId"},
		{"_user_id", "UserId"},
	}
	for _, suffix := range suffixes {
		if strings.HasSuffix(fieldName, suffix.suffix) {
			return suffix.name, true
		}
	}
	return "", false
}

func isUUIDField(fieldName string) bool {
	if fieldName == "trace_id" || fieldName == "span_id" {
		return false
	}
	return fieldName == "id" || strings.HasSuffix(fieldName, "_id")
}

func isOpaqueIDField(schemaName string, fieldName string) bool {
	if schemaName == "IssueAccessGrantRequest" && fieldName == "expected_media_connection_id" {
		return true
	}
	if schemaName == "SFUSubscriptionsResponse" && fieldName == "session_id" {
		return true
	}
	if fieldName == "publication_id" || fieldName == "track_id" || fieldName == "external_id" || fieldName == "identity_external_id" {
		return true
	}
	return fieldName == "connection_id" && strings.HasPrefix(schemaName, "CloudflareSFU")
}
