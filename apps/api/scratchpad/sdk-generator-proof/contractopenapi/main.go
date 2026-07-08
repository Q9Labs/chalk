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
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type openAPIDoc struct {
	OpenAPI    string                    `json:"openapi"`
	Info       openAPIInfo               `json:"info"`
	Paths      map[string]map[string]any `json:"paths"`
	Components openAPIComponents         `json:"components"`
}

type openAPIInfo struct {
	Title   string `json:"title"`
	Version string `json:"version"`
}

type openAPIComponents struct {
	SecuritySchemes map[string]any            `json:"securitySchemes"`
	Schemas         map[string]map[string]any `json:"schemas"`
}

type generator struct {
	doc openAPIDoc
}

func main() {
	gen := newGenerator()
	for _, route := range httpapi.PreviewRouteContracts() {
		gen.addRoute(route)
	}

	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(gen.doc); err != nil {
		panic(err)
	}
}

func newGenerator() *generator {
	gen := &generator{
		doc: openAPIDoc{
			OpenAPI: "3.1.0",
			Info: openAPIInfo{
				Title:   "Chalk API contract preview",
				Version: "0.0.0-preview",
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
	return gen
}

func (g *generator) addRoute(route httpapi.APIRouteContract) {
	if route.Path == "" || route.Method == "" {
		return
	}

	method := strings.ToLower(route.Method)
	operation := map[string]any{
		"operationId": route.OperationID,
		"responses":   g.responses(route),
	}

	if route.Auth != "" {
		operation["security"] = []map[string][]string{
			{"sessionOrBearer": {}},
		}
	}

	if len(route.Parameters) > 0 {
		operation["parameters"] = parameters(route.Parameters)
	}

	if route.RateLimit.Name != "" {
		operation["x-chalk-rate-limit"] = map[string]any{
			"name":           route.RateLimit.Name,
			"limit":          route.RateLimit.Limit,
			"window_seconds": int(route.RateLimit.Window.Seconds()),
		}
	}

	if route.Request != nil {
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
		responses[strconv.Itoa(status)] = map[string]any{
			"description":         http.StatusText(status),
			"x-chalk-error-codes": errorCodes(errors),
			"content": map[string]any{
				"application/json": map[string]any{
					"schema": map[string]any{"$ref": "#/components/schemas/ErrorResponse"},
				},
			},
		}
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

func parameters(parameters []httpapi.APIParameterContract) []map[string]any {
	result := make([]map[string]any, 0, len(parameters))
	for _, parameter := range parameters {
		result = append(result, map[string]any{
			"name":     parameter.Name,
			"in":       parameter.In,
			"required": parameter.Required,
			"schema": map[string]any{
				"type": parameter.Type,
			},
		})
	}
	return result
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

func (g *generator) schemaRef(ref httpapi.APISchemaRef, request bool) map[string]any {
	if _, ok := g.doc.Components.Schemas[ref.Name]; !ok {
		g.doc.Components.Schemas[ref.Name] = g.schemaFromType(reflect.TypeOf(ref.Type), request)
	}
	return map[string]any{"$ref": "#/components/schemas/" + ref.Name}
}

func (g *generator) schemaFromType(t reflect.Type, request bool) map[string]any {
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
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
		return g.objectSchema(t, request)
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
			"items": g.schemaFromType(t.Elem(), request),
		}
	case reflect.Map:
		return map[string]any{
			"type":                 "object",
			"additionalProperties": g.schemaFromType(t.Elem(), request),
		}
	default:
		return map[string]any{"type": "object", "x-go-type": t.String()}
	}
}

func (g *generator) objectSchema(t reflect.Type, request bool) map[string]any {
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
		optional := request && isOptionalRequestField(fieldType)
		nullable := fieldType.Kind() == reflect.Pointer || isNullableHelper(fieldType)
		property := g.schemaFromType(fieldType, request)
		if nullable {
			property = nullableSchema(property)
		}

		properties[name] = property
		if !request || !optional {
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

func nullableSchema(schema map[string]any) map[string]any {
	if typeSet, ok := schema["type"].([]string); ok && includes(typeSet, "null") {
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
		cloned["anyOf"] = []map[string]any{
			schema,
			{"type": "null"},
		}
	}

	return cloned
}

func isOptionalRequestField(t reflect.Type) bool {
	return t.Kind() == reflect.Pointer ||
		isOptionalString(t) ||
		isOptionalJSON(t) ||
		isOptionalStrings(t) ||
		isOptionalTimeRequest(t)
}

func isNullableHelper(t reflect.Type) bool {
	return isOptionalString(t) ||
		isOptionalJSON(t) ||
		isOptionalStrings(t) ||
		isOptionalTimeRequest(t)
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
	return map[string]any{
		"type":   "string",
		"format": "date-time",
	}
}

func jsonValueSchema() map[string]any {
	return map[string]any{
		"type":                 []string{"object", "array", "string", "number", "boolean", "null"},
		"items":                map[string]any{},
		"additionalProperties": true,
	}
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
