package main

import (
	"encoding/json"
	"net/http"
	"os"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type openAPIDoc struct {
	OpenAPI    string                    `json:"openapi"`
	Info       openAPIInfo               `json:"info"`
	Servers    []openAPIServer           `json:"servers"`
	Paths      map[string]map[string]any `json:"paths"`
	Components openAPIComponents         `json:"components"`
}

type openAPIInfo struct {
	Title   string         `json:"title"`
	Version string         `json:"version"`
	License openAPILicense `json:"license"`
}

type openAPILicense struct {
	Name       string `json:"name"`
	Identifier string `json:"identifier"`
}

type openAPIServer struct {
	URL         string `json:"url"`
	Description string `json:"description"`
}

type openAPIComponents struct {
	SecuritySchemes map[string]any            `json:"securitySchemes"`
	Schemas         map[string]map[string]any `json:"schemas"`
}

type generator struct {
	doc         openAPIDoc
	schemaNames map[reflect.Type]string
}

func main() {
	routes := httpapi.PreviewRouteContracts()
	gen := newGenerator(routes)
	for _, route := range routes {
		gen.addRoute(route)
	}

	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(gen.doc); err != nil {
		panic(err)
	}
}

func newGenerator(routes []httpapi.APIRouteContract) *generator {
	gen := &generator{
		schemaNames: schemaNames(routes),
		doc: openAPIDoc{
			OpenAPI: "3.1.0",
			Info: openAPIInfo{
				Title:   "Chalk API contract preview",
				Version: "0.0.0-preview",
				License: openAPILicense{
					Name:       "Apache-2.0",
					Identifier: "Apache-2.0",
				},
			},
			Servers: []openAPIServer{
				{URL: "https://api.chalk.q9labs.com", Description: "Production API"},
			},
			Paths: make(map[string]map[string]any),
			Components: openAPIComponents{
				SecuritySchemes: map[string]any{
					"sessionOrBearer": map[string]any{
						"type":        "http",
						"scheme":      "bearer",
						"description": "Preview placeholder for routes accepted by Chalk session auth or bearer/API-key auth.",
					},
				},
				Schemas: make(map[string]map[string]any),
			},
		},
	}
	gen.doc.Components.Schemas["ErrorResponse"] = errorResponseSchema()
	for name, schema := range scalarSchemas() {
		gen.doc.Components.Schemas[name] = schema
	}
	gen.doc.Components.Schemas["Pagination"] = paginationSchema()
	for name, schema := range providerConfigSchemas() {
		gen.doc.Components.Schemas[name] = schema
	}
	return gen
}

func schemaNames(routes []httpapi.APIRouteContract) map[reflect.Type]string {
	names := make(map[reflect.Type]string)
	for _, route := range routes {
		if route.Request != nil {
			names[dereference(reflect.TypeOf(route.Request.Type))] = route.Request.Name
		}
		for _, response := range route.Responses {
			if response.Schema != nil {
				names[dereference(reflect.TypeOf(response.Schema.Type))] = response.Schema.Name
			}
		}
	}
	return names
}

func (g *generator) addRoute(route httpapi.APIRouteContract) {
	if route.Path == "" || route.Method == "" {
		return
	}

	method := strings.ToLower(route.Method)
	operation := map[string]any{
		"operationId": route.OperationID,
		"summary":     operationSummary(route.OperationID),
		"responses":   g.responses(route),
	}

	if route.Auth != "" {
		operation["security"] = []map[string][]string{
			{"sessionOrBearer": {}},
		}
	} else {
		operation["security"] = []map[string][]string{}
	}

	if len(route.Parameters) > 0 {
		operation["parameters"] = g.parameters(route.Parameters)
	}

	if route.RateLimit.Name != "" {
		operation["x-chalk-rate-limit"] = map[string]any{
			"name":           route.RateLimit.Name,
			"limit":          route.RateLimit.Limit,
			"window_seconds": int(route.RateLimit.Window.Seconds()),
		}
	}

	if route.Request != nil {
		if route.BodyLimitBytes > 0 {
			operation["x-chalk-max-body-bytes"] = route.BodyLimitBytes
		}
		operation["requestBody"] = map[string]any{
			"required": true,
			"content": map[string]any{
				"application/json": map[string]any{
					"schema": g.schemaRef(*route.Request, true),
				},
			},
		}
	}

	if g.doc.Paths[route.Path] == nil {
		g.doc.Paths[route.Path] = make(map[string]any)
	}
	g.doc.Paths[route.Path][method] = operation
}

func (g *generator) responses(route httpapi.APIRouteContract) map[string]any {
	responses := make(map[string]any)
	for _, response := range route.Responses {
		body := map[string]any{
			"description": http.StatusText(response.Status),
		}
		if len(response.Headers) > 0 {
			body["headers"] = headers(response.Headers)
		}
		if response.Schema != nil {
			body["content"] = map[string]any{
				"application/json": map[string]any{
					"schema": g.schemaRef(*response.Schema, false),
				},
			}
		}
		responses[strconv.Itoa(response.Status)] = body
	}

	for status, errors := range groupErrors(route.Errors) {
		body := map[string]any{
			"description":         http.StatusText(status),
			"x-chalk-error-codes": errorCodes(errors),
			"content": map[string]any{
				"application/json": map[string]any{
					"schema": map[string]any{"$ref": "#/components/schemas/ErrorResponse"},
				},
			},
		}
		if status == http.StatusTooManyRequests {
			body["headers"] = headers(rateLimitResponseHeaders(true))
		}
		responses[strconv.Itoa(status)] = body
	}

	return responses
}

func headers(headers []httpapi.APIHeaderContract) map[string]any {
	result := make(map[string]any, len(headers))
	for _, header := range headers {
		result[header.Name] = map[string]any{
			"required": header.Required,
			"schema": map[string]any{
				"type": header.Type,
			},
		}
	}
	return result
}

func rateLimitResponseHeaders(includeRetryAfter bool) []httpapi.APIHeaderContract {
	responseHeaders := []httpapi.APIHeaderContract{
		{Name: ratelimit.HeaderLimit, Type: "integer", Required: true},
		{Name: ratelimit.HeaderRemaining, Type: "integer", Required: true},
	}
	if includeRetryAfter {
		responseHeaders = append(responseHeaders, httpapi.APIHeaderContract{Name: ratelimit.HeaderRetryAfter, Type: "integer", Required: true})
	}
	return responseHeaders
}

func (g *generator) parameters(parameters []httpapi.APIParameterContract) []map[string]any {
	result := make([]map[string]any, 0, len(parameters))
	for _, parameter := range parameters {
		result = append(result, map[string]any{
			"name":     parameter.Name,
			"in":       parameter.In,
			"required": parameter.Required,
			"schema":   g.parameterSchema(parameter),
		})
	}
	return result
}

func (g *generator) parameterSchema(parameter httpapi.APIParameterContract) map[string]any {
	if parameter.Type == "string" {
		if name, ok := idSchemaName("", parameter.Name); ok {
			return schemaReference(name)
		}
	}

	return map[string]any{"type": parameter.Type}
}

func groupErrors(errors []httpapi.APIError) map[int][]httpapi.APIError {
	grouped := make(map[int][]httpapi.APIError)
	for _, err := range errors {
		grouped[err.Status] = append(grouped[err.Status], err)
	}
	return grouped
}

func errorCodes(errors []httpapi.APIError) []string {
	codes := make([]string, 0, len(errors))
	for _, err := range errors {
		codes = append(codes, err.Code)
	}
	sort.Strings(codes)
	return codes
}

func operationSummary(operationID string) string {
	if operationID == "" {
		return ""
	}

	var words []string
	start := 0
	for i := 1; i < len(operationID); i++ {
		if operationID[i] >= 'A' && operationID[i] <= 'Z' {
			words = append(words, operationID[start:i])
			start = i
		}
	}
	words = append(words, operationID[start:])

	summary := strings.Join(words, " ")
	return strings.ToUpper(summary[:1]) + strings.ToLower(summary[1:])
}

func (g *generator) schemaRef(ref httpapi.APISchemaRef, request bool) map[string]any {
	if _, ok := g.doc.Components.Schemas[ref.Name]; !ok {
		g.doc.Components.Schemas[ref.Name] = g.schemaFromType(reflect.TypeOf(ref.Type), request, ref.Name)
	}
	return map[string]any{"$ref": "#/components/schemas/" + ref.Name}
}

func (g *generator) schemaFromType(t reflect.Type, request bool, currentName string) map[string]any {
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}

	if name, ok := g.schemaNames[dereference(t)]; ok && name != currentName {
		if _, exists := g.doc.Components.Schemas[name]; !exists {
			g.doc.Components.Schemas[name] = g.schemaFromType(t, request, name)
		}
		return map[string]any{"$ref": "#/components/schemas/" + name}
	}

	if isTime(t) {
		return timestampSchema()
	}
	if isRawJSON(t) || isOptionalJSON(t) {
		return jsonValueSchema()
	}
	if isOptionalString(t) {
		return map[string]any{"type": []string{"string", "null"}}
	}
	if isOptionalStrings(t) {
		return map[string]any{
			"type":  []string{"array", "null"},
			"items": map[string]any{"type": "string"},
		}
	}
	if isOptionalTimeRequest(t) {
		return nullableSchema(timestampSchema())
	}

	switch t.Kind() {
	case reflect.Struct:
		return g.objectSchema(t, request, currentName)
	case reflect.Interface:
		return jsonValueSchema()
	case reflect.String:
		return map[string]any{"type": "string"}
	case reflect.Bool:
		return map[string]any{"type": "boolean"}
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return map[string]any{"type": "integer"}
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return map[string]any{"type": "integer", "minimum": 0}
	case reflect.Float32, reflect.Float64:
		return map[string]any{"type": "number"}
	case reflect.Slice, reflect.Array:
		return map[string]any{
			"type":  "array",
			"items": g.schemaFromType(t.Elem(), request, currentName),
		}
	case reflect.Map:
		return map[string]any{
			"type":                 "object",
			"additionalProperties": g.schemaFromType(t.Elem(), request, currentName),
		}
	default:
		return map[string]any{"type": "object", "x-go-type": t.String()}
	}
}

func (g *generator) objectSchema(t reflect.Type, request bool, currentName string) map[string]any {
	properties := make(map[string]any)
	required := make([]string, 0, t.NumField())

	for i := 0; i < t.NumField(); i++ {
		field := t.Field(i)
		if field.PkgPath != "" {
			continue
		}

		name, ok := jsonFieldName(field)
		if !ok {
			continue
		}

		fieldType := field.Type
		optional := (request && isOptionalRequestField(fieldType)) || jsonFieldOmitsEmpty(field)
		nullable := fieldType.Kind() == reflect.Pointer || nullableHelperField(currentName, name, fieldType)
		property := g.fieldSchema(currentName, name, field, request)
		if nullable && !schemaIncludesNull(property) {
			property = nullableSchema(property)
		}

		properties[name] = property
		if !optional {
			required = append(required, name)
		}
	}

	sort.Strings(required)
	schema := map[string]any{
		"type":                 "object",
		"properties":           properties,
		"additionalProperties": false,
	}
	if len(required) > 0 {
		schema["required"] = required
	}
	return schema
}

func (g *generator) fieldSchema(schemaName string, fieldName string, field reflect.StructField, request bool) map[string]any {
	fieldType := field.Type
	if schemaName := field.Tag.Get("schema"); schemaName != "" {
		return schemaReference(schemaName)
	}
	if name, ok := providerConfigSchemaName(fieldName); ok {
		return schemaReference(name)
	}
	if fieldName == "pagination" {
		return schemaReference("Pagination")
	}
	if name, ok := idSchemaName(schemaName, fieldName); ok {
		return schemaReference(name)
	}
	if isTimestampStringField(fieldName, fieldType) || isTime(fieldType) || isOptionalTimeRequest(fieldType) {
		return schemaReference("DateTimeString")
	}
	if fieldName == "email" {
		return schemaReference("Email")
	}
	if fieldName == "website" || strings.HasSuffix(fieldName, "_url") {
		return schemaReference("URLString")
	}

	if isOptionalString(fieldType) {
		schema := stringSchema()
		return applyFieldConstraints(schema, schemaName, fieldName, request)
	}
	if isOptionalStrings(fieldType) {
		schema := map[string]any{
			"type":  "array",
			"items": stringSchema(),
		}
		return applyFieldConstraints(schema, schemaName, fieldName, request)
	}

	schema := g.schemaFromType(fieldType, request, schemaName)
	return applyFieldConstraints(schema, schemaName, fieldName, request)
}

func applyFieldConstraints(schema map[string]any, schemaName string, fieldName string, request bool) map[string]any {
	if enum := fieldEnum(schemaName, fieldName); len(enum) > 0 {
		schema["enum"] = enum
	}
	if isUUIDField(fieldName) {
		schema["format"] = "uuid"
		schema["minLength"] = 36
		schema["maxLength"] = 36
	}
	if fieldName == "email" {
		schema["format"] = "email"
	}
	if fieldName == "website" || strings.HasSuffix(fieldName, "_url") {
		schema["format"] = "uri"
	}
	if request && schemaTypeIs(schema, "string") && !schemaIncludesNull(schema) && len(fieldEnum(schemaName, fieldName)) == 0 {
		schema["minLength"] = 1
	}
	if fieldName == "languages" && schemaTypeIs(schema, "array") {
		schema["minItems"] = 1
		if items, ok := schema["items"].(map[string]any); ok {
			items["minLength"] = 1
		}
	}
	return schema
}

func fieldEnum(schemaName string, fieldName string) []string {
	switch fieldName {
	case "role":
		return []string{"owner", "admin", "member", "viewer"}
	case "storage_provider":
		return []string{"r2"}
	case "status":
		switch schemaName {
		case "Room", "RoomList", "CreateRoomRequest", "UpdateRoomRequest":
			return []string{"active", "archived", "ended"}
		case "RoomSession", "RoomSessionList", "CreateRoomSessionRequest", "UpdateRoomSessionRequest":
			return []string{"pending", "active", "ended", "failed"}
		case "Recording", "RecordingList", "CreateRecordingRequest", "UpdateRecordingRequest", "Transcript", "TranscriptList", "CreateTranscriptRequest", "UpdateTranscriptRequest":
			return []string{"pending", "processing", "completed", "failed"}
		}
	}
	return nil
}

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

func nullableSchema(schema map[string]any) map[string]any {
	if schemaIncludesNull(schema) {
		return schema
	}

	cloned := make(map[string]any, len(schema)+1)
	for key, value := range schema {
		cloned[key] = value
	}

	switch value := cloned["type"].(type) {
	case string:
		cloned["type"] = []string{value, "null"}
	case []string:
		cloned["type"] = append(value, "null")
	default:
		return map[string]any{
			"anyOf": []map[string]any{
				schema,
				{"type": "null"},
			},
		}
	}

	return cloned
}

func isOptionalRequestField(t reflect.Type) bool {
	return t.Kind() == reflect.Pointer ||
		isRawJSON(t) ||
		isOptionalString(t) ||
		isOptionalJSON(t) ||
		isOptionalStrings(t) ||
		isOptionalTimeRequest(t)
}

func nullableHelperField(schemaName string, fieldName string, t reflect.Type) bool {
	if _, ok := providerConfigSchemaName(fieldName); ok {
		return true
	}
	if isOptionalString(t) {
		return optionalStringAllowsNull(schemaName, fieldName)
	}
	if isOptionalStrings(t) {
		return false
	}
	return isOptionalJSON(t) || isOptionalTimeRequest(t)
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

func timestampSchema() map[string]any {
	return schemaReference("DateTimeString")
}

func stringSchema() map[string]any {
	return map[string]any{"type": "string"}
}

func jsonValueSchema() map[string]any {
	return map[string]any{
		"type":                 []string{"object", "array", "string", "number", "boolean", "null"},
		"items":                map[string]any{},
		"additionalProperties": true,
	}
}

func providerConfigSchemaName(fieldName string) (string, bool) {
	switch fieldName {
	case "media_plane_provider_config":
		return "MediaPlaneProviderConfig", true
	case "ai_provider_config":
		return "AIProviderConfig", true
	case "storage_provider_config":
		return "StorageProviderConfig", true
	default:
		return "", false
	}
}

func providerConfigSchemas() map[string]map[string]any {
	return map[string]map[string]any{
		"MediaPlaneProviderConfig": {
			"type":                 "object",
			"additionalProperties": true,
			"properties": map[string]any{
				"enabled":  map[string]any{"type": "boolean"},
				"provider": map[string]any{"type": "string", "enum": []string{"cf_sfu", "cf_rtk"}},
				"mode":     providerModeSchema(),
				"cloudflare": map[string]any{
					"type":                 "object",
					"additionalProperties": true,
					"properties": map[string]any{
						"account_id": secretCapableStringSchema(),
						"api_token":  secretCapableStringSchema(),
						"rtk": map[string]any{
							"type":                 "object",
							"additionalProperties": true,
							"properties": map[string]any{
								"enabled":            map[string]any{"type": "boolean"},
								"app_id":             secretCapableStringSchema(),
								"host_preset":        nonEmptyStringSchema(),
								"participant_preset": nonEmptyStringSchema(),
							},
						},
						"sfu": map[string]any{
							"type":                 "object",
							"additionalProperties": true,
							"properties": map[string]any{
								"enabled":    map[string]any{"type": "boolean"},
								"app_id":     secretCapableStringSchema(),
								"app_secret": secretCapableStringSchema(),
							},
						},
					},
				},
			},
		},
		"AIProviderConfig": {
			"type":                 "object",
			"additionalProperties": true,
			"properties": map[string]any{
				"enabled":        map[string]any{"type": "boolean"},
				"provider":       map[string]any{"type": "string", "enum": []string{"openrouter"}},
				"mode":           providerModeSchema(),
				"api_key":        secretCapableStringSchema(),
				"base_url":       schemaReference("URLString"),
				"default_model":  nonEmptyStringSchema(),
				"fallback_model": nonEmptyStringSchema(),
				"allowed_models": map[string]any{
					"type":     "array",
					"minItems": 1,
					"items":    nonEmptyStringSchema(),
				},
			},
		},
		"StorageProviderConfig": {
			"type":                 "object",
			"additionalProperties": true,
			"properties": map[string]any{
				"enabled":           map[string]any{"type": "boolean"},
				"provider":          map[string]any{"type": "string", "enum": []string{"cloudflare_r2", "aws_s3"}},
				"mode":              providerModeSchema(),
				"bucket":            nonEmptyStringSchema(),
				"prefix":            nonEmptyStringSchema(),
				"access_key_id":     secretCapableStringSchema(),
				"secret_access_key": secretCapableStringSchema(),
			},
		},
	}
}

func providerModeSchema() map[string]any {
	return map[string]any{"type": "string", "enum": []string{"chalk_managed", "tenant_managed"}}
}

func nonEmptyStringSchema() map[string]any {
	return map[string]any{"type": "string", "minLength": 1}
}

func secretCapableStringSchema() map[string]any {
	return map[string]any{"type": "string", "minLength": 1}
}

func scalarSchemas() map[string]map[string]any {
	schemas := map[string]map[string]any{
		"UUID":                 brandedStringSchema("UUID", "uuid", 36, 36),
		"Email":                brandedStringSchema("Email", "email", 0, 0),
		"URLString":            brandedStringSchema("URLString", "uri", 0, 0),
		"DateTimeString":       brandedStringSchema("DateTimeString", "date-time", 0, 0),
		"IntegrationServiceId": brandedStringSchema("IntegrationServiceId", "", 1, 0),
		"IntegrationActionId":  brandedStringSchema("IntegrationActionId", "", 1, 0),
	}
	for _, name := range idSchemaNames() {
		schemas[name] = brandedStringSchema(name, "uuid", 36, 36)
	}
	return schemas
}

func brandedStringSchema(brand string, format string, minLength int, maxLength int) map[string]any {
	schema := map[string]any{
		"type":          "string",
		"x-chalk-brand": brand,
	}
	if format != "" {
		schema["format"] = format
	}
	if minLength > 0 {
		schema["minLength"] = minLength
	}
	if maxLength > 0 {
		schema["maxLength"] = maxLength
	}
	return schema
}

func paginationSchema() map[string]any {
	return map[string]any{
		"type": "object",
		"required": []string{
			"has_more",
			"next_cursor",
			"page_size",
		},
		"properties": map[string]any{
			"has_more":    map[string]any{"type": "boolean"},
			"next_cursor": map[string]any{"type": []string{"string", "null"}},
			"page_size":   map[string]any{"type": "integer"},
		},
		"additionalProperties": false,
	}
}

func schemaReference(name string) map[string]any {
	return map[string]any{"$ref": "#/components/schemas/" + name}
}

func idSchemaNames() []string {
	return []string{
		"AuditLogId",
		"MembershipId",
		"RecordingId",
		"RoomId",
		"RoomSessionId",
		"TenantId",
		"TranscriptId",
		"UserId",
	}
}

func idSchemaName(schemaName string, fieldName string) (string, bool) {
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
		case "Room":
			return "RoomId", true
		case "RoomSession":
			return "RoomSessionId", true
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
	case "room_id":
		return "RoomId", true
	case "session_id":
		return "RoomSessionId", true
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
		{"_membership_id", "MembershipId"},
		{"_recording_id", "RecordingId"},
		{"_room_id", "RoomId"},
		{"_session_id", "RoomSessionId"},
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
	return fieldName == "id" || strings.HasSuffix(fieldName, "_id")
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

func errorResponseSchema() map[string]any {
	return map[string]any{
		"type": "object",
		"required": []string{
			"error",
		},
		"properties": map[string]any{
			"error": map[string]any{
				"type": "object",
				"required": []string{
					"code",
					"message",
				},
				"properties": map[string]any{
					"code":    map[string]any{"type": "string"},
					"message": map[string]any{"type": "string"},
				},
				"additionalProperties": false,
			},
		},
		"additionalProperties": false,
	}
}
