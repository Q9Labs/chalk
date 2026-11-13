package main

import (
	"encoding/json"
	"reflect"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func jsonFieldName(field reflect.StructField) (string, bool) {
	tag := field.Tag.Get("json")
	if tag == "-" {
		return "", false
	}

	name, _, _ := strings.Cut(tag, ",")
	if name == "" {
		name = field.Name
	}
	return name, true
}

func jsonFieldOmitsEmpty(field reflect.StructField) bool {
	parts := strings.Split(field.Tag.Get("json"), ",")
	return includes(parts[1:], "omitempty")
}

func isOptionalRequestField(t reflect.Type) bool {
	if dereference(t) == reflect.TypeOf(artifactpolicy.OptionalTranscriptLanguage{}) {
		return true
	}
	return t.Kind() == reflect.Pointer ||
		isRawJSON(t) ||
		isOptionalString(t) ||
		isOptionalJSON(t) ||
		isOptionalStrings(t) ||
		isOptionalInt64(t) ||
		isOptionalInt32(t) ||
		isOptionalCORSOrigins(t) ||
		isOptionalTimeRequest(t)
}

func optionalStringAllowsNull(schemaName string, fieldName string) bool {
	switch fieldName {
	case "default_region", "default_media_plane", "logo_key", "website", "storage_key", "text":
		return true
	case "name":
		return false
	case "status", "role", "slug", "media_plane", "provider", "model":
		return false
	}
	return !strings.HasPrefix(schemaName, "Update")
}

func isOptionalString(t reflect.Type) bool {
	return dereference(t) == reflect.TypeOf(utilities.OptionalString{})
}

func isOptionalJSON(t reflect.Type) bool {
	return dereference(t) == reflect.TypeOf(utilities.OptionalJSON{})
}

func isOptionalStrings(t reflect.Type) bool {
	return dereference(t) == reflect.TypeOf(transcripts.OptionalStrings{})
}

func isOptionalInt64(t reflect.Type) bool {
	return dereference(t) == reflect.TypeOf(tenants.OptionalInt64{})
}

func isOptionalInt32(t reflect.Type) bool {
	return dereference(t) == reflect.TypeOf(spaces.OptionalInt32{})
}

func isOptionalCORSOrigins(t reflect.Type) bool {
	return dereference(t) == reflect.TypeOf(tenants.OptionalCORSOrigins{})
}

func isRawJSON(t reflect.Type) bool {
	return dereference(t) == reflect.TypeOf(json.RawMessage{})
}

func isTime(t reflect.Type) bool {
	return dereference(t) == reflect.TypeOf(time.Time{})
}

func isTimestampStringField(name string, t reflect.Type) bool {
	return strings.HasSuffix(name, "_at") && dereference(t).Kind() == reflect.String
}

func isOptionalTimeRequest(t reflect.Type) bool {
	t = dereference(t)
	return t.Kind() == reflect.Struct &&
		t.Name() == "optionalTimeRequest" &&
		strings.HasSuffix(t.PkgPath(), "/internal/httpapi")
}

func dereference(t reflect.Type) reflect.Type {
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	return t
}

func schemaTypeIs(schema map[string]any, value string) bool {
	switch schemaType := schema["type"].(type) {
	case string:
		return schemaType == value
	case []string:
		return includes(schemaType, value)
	default:
		return false
	}
}

func schemaIncludesNull(schema map[string]any) bool {
	if typeSet, ok := schema["type"].([]string); ok && includes(typeSet, "null") {
		return true
	}
	if anyOf, ok := schema["anyOf"].([]map[string]any); ok {
		for _, member := range anyOf {
			if member["type"] == "null" {
				return true
			}
		}
	}
	return false
}

func includes(values []string, needle string) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}
