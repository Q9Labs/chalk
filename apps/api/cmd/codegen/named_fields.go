package main

import (
	"fmt"
	"reflect"
	"strings"
)

// namedFieldSchema returns the fixed schema a field gets from its schema, tag or name, before its Go type is read.
func namedFieldSchema(schemaName string, fieldName string, field reflect.StructField) (map[string]any, bool) {
	if schema, ok := attendanceFieldSchema(schemaName, fieldName); ok {
		return schema, true
	}
	if name, ok := recordingFieldSchemaName(schemaName, fieldName); ok {
		return schemaReference(name), true
	}
	if tagged := field.Tag.Get("schema"); tagged != "" {
		return schemaReference(tagged), true
	}
	if name, ok := providerConfigSchemaName(fieldName); ok {
		return schemaReference(name), true
	}
	switch fieldName {
	case "pagination":
		return schemaReference("Pagination"), true
	case "trace_id":
		return nullableSchema(traceIdentifierSchema(32)), true
	case "span_id":
		return nullableSchema(traceIdentifierSchema(16)), true
	}
	if name, ok := idSchemaName(schemaName, fieldName); ok {
		return schemaReference(name), true
	}
	if isTimestampStringField(fieldName, field.Type) || isTime(field.Type) || isOptionalTimeRequest(field.Type) {
		return schemaReference("DateTimeString"), true
	}
	if fieldName == "email" {
		return schemaReference("Email"), true
	}
	if fieldName == "website" || strings.HasSuffix(fieldName, "_url") {
		return schemaReference("URLString"), true
	}
	return nil, false
}

func attendanceFieldSchema(schemaName string, fieldName string) (map[string]any, bool) {
	if schemaName != "EpisodeAttendance" {
		return nil, false
	}
	switch fieldName {
	case "external_id":
		return map[string]any{"type": "string"}, true
	case "identity_kind":
		return map[string]any{"type": "string", "enum": []string{"user", "agent", "guest"}}, true
	case "left_reason":
		return map[string]any{"anyOf": []map[string]any{
			{"type": "string", "enum": []string{"left", "episode_ended"}},
			{"type": "null"},
		}}, true
	}
	return nil, false
}

func recordingFieldSchemaName(schemaName string, fieldName string) (string, bool) {
	switch {
	case schemaName == "Recording" && fieldName == "source":
		return "RecordingSource", true
	case schemaName == "Recording" && fieldName == "transcription_preparation":
		return "RecordingTranscriptionPreparation", true
	case (schemaName == "Recording" || schemaName == "RecordingExportRequestAcceptedResponse") && fieldName == "export":
		return "RecordingExport", true
	}
	return "", false
}

func recordingArtifactSchemas() map[string]map[string]any {
	return map[string]map[string]any{
		"RecordingSource": {
			"type":                 "object",
			"additionalProperties": false,
			"required":             []string{"status"},
			"properties": map[string]any{
				"status":      map[string]any{"type": "string", "enum": []string{"pending", "available", "failed", "expired"}},
				"expires_at":  nullableSchema(timestampSchema()),
				"stop_reason": map[string]any{"type": "string", "enum": []string{"duration_limit"}},
			},
		},
		"RecordingExport": {
			"type":                 "object",
			"additionalProperties": false,
			"required":             []string{"status", "retryable"},
			"properties": map[string]any{
				"job_id":            map[string]any{"type": "string", "format": "uuid"},
				"status":            map[string]any{"type": "string", "enum": []string{"none", "pending", "ready", "failed", "unavailable"}},
				"retryable":         map[string]any{"type": "boolean"},
				"source_expires_at": nullableSchema(timestampSchema()),
				"failure_code":      nullableSchema(stringSchema()),
				"failure_message":   nullableSchema(stringSchema()),
			},
		},
		"RecordingTranscriptionPreparation": {
			"type":                 "object",
			"additionalProperties": false,
			"required":             []string{"status"},
			"properties": map[string]any{
				"status":       map[string]any{"type": "string", "enum": []string{"none", "pending", "ready", "failed", "expired"}},
				"expires_at":   nullableSchema(timestampSchema()),
				"failure_code": stringSchema(),
			},
		},
	}
}

func traceIdentifierSchema(length int) map[string]any {
	return map[string]any{
		"type":      "string",
		"minLength": length,
		"maxLength": length,
		"pattern":   fmt.Sprintf("^(?=.*[1-9a-fA-F])[0-9a-fA-F]{%d}$", length),
	}
}
