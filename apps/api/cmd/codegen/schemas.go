package main

import (
	"reflect"
	"sort"

	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
)

func (g *generator) schemaRef(ref httpapi.APISchemaRef, request bool) map[string]any {
	if _, ok := g.doc.Components.Schemas[ref.Name]; !ok {
		g.doc.Components.Schemas[ref.Name] = g.schemaFromType(reflect.TypeOf(ref.Type), request, ref.Name)
	}
	return map[string]any{"$ref": "#/components/schemas/" + ref.Name}
}

func (g *generator) schemaFromType(t reflect.Type, request bool, currentName string) map[string]any {
	if dereference(t) == reflect.TypeOf(artifactpolicy.OptionalTranscriptLanguage{}) {
		return map[string]any{"type": "string"}
	}
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}

	if name, ok := g.schemaNames[dereference(t)]; ok && name != currentName {
		if _, exists := g.doc.Components.Schemas[name]; !exists {
			g.doc.Components.Schemas[name] = g.schemaFromType(t, request, name)
		}
		return map[string]any{"$ref": "#/components/schemas/" + name}
	}

	if schema, ok := wrapperSchema(t); ok {
		return schema
	}
	return g.kindSchema(t, request, currentName)
}

// wrapperSchema covers the Chalk types whose JSON shape differs from their Go kind.
func wrapperSchema(t reflect.Type) (map[string]any, bool) {
	switch {
	case isTime(t):
		return timestampSchema(), true
	case isRawJSON(t) || isOptionalJSON(t):
		return jsonValueSchema(), true
	case isOptionalString(t):
		return map[string]any{"type": []string{"string", "null"}}, true
	case isOptionalStrings(t):
		return map[string]any{
			"type":  []string{"array", "null"},
			"items": map[string]any{"type": "string"},
		}, true
	case isOptionalInt64(t):
		return map[string]any{"type": []string{"integer", "null"}}, true
	case isOptionalInt32(t):
		// The Space service rejects an explicit null for these durations.
		return map[string]any{"type": "integer"}, true
	case isOptionalCORSOrigins(t):
		return corsOriginsSchema(), true
	case isOptionalTimeRequest(t):
		return nullableSchema(timestampSchema()), true
	}
	return nil, false
}

func corsOriginsSchema() map[string]any {
	return map[string]any{
		"type":     "array",
		"maxItems": tenants.MaxCORSOrigins,
		"items": map[string]any{
			"type":      "string",
			"format":    "uri",
			"maxLength": tenants.MaxCORSOriginBytes,
			"pattern":   tenants.CORSOriginPattern,
		},
	}
}

func (g *generator) kindSchema(t reflect.Type, request bool, currentName string) map[string]any {
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

		if name == "transcript_language" && schemaIncludesNull(property) {
			values := make([]any, 0, len(artifactpolicy.TranscriptLanguageValues())+1)
			for _, value := range artifactpolicy.TranscriptLanguageValues() {
				values = append(values, value)
			}
			property["enum"] = append(values, nil)
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
	if schema, ok := namedFieldSchema(schemaName, fieldName, field); ok {
		return schema
	}
	fieldType := field.Type
	var schema map[string]any
	switch {
	case isOptionalString(fieldType):
		schema = stringSchema()
	case isOptionalStrings(fieldType):
		schema = map[string]any{"type": "array", "items": stringSchema()}
	case isOptionalCORSOrigins(fieldType):
		schema = corsOriginsSchema()
	default:
		schema = g.schemaFromType(fieldType, request, schemaName)
	}
	return applyFieldConstraints(schema, schemaName, fieldName, request)
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

func nullableHelperField(schemaName string, fieldName string, t reflect.Type) bool {
	if dereference(t) == reflect.TypeOf(artifactpolicy.OptionalTranscriptLanguage{}) {
		return schemaName != "UpdateTenantRequest"
	}
	if _, ok := providerConfigSchemaName(fieldName); ok {
		return true
	}
	if isOptionalString(t) {
		return optionalStringAllowsNull(schemaName, fieldName)
	}
	if isOptionalStrings(t) {
		return false
	}
	if isOptionalInt64(t) {
		return true
	}
	if isOptionalInt32(t) || isOptionalCORSOrigins(t) {
		return false
	}
	return isOptionalJSON(t) || isOptionalTimeRequest(t)
}
