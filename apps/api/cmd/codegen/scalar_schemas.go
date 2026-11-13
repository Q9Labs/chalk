package main

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
			"description":          "Provider-specific properties are opaque to this API contract. The server's media-plane adapter for the named provider validates them, and secret values are redacted in API responses.",
			"additionalProperties": true,
			"properties": map[string]any{
				"enabled":  map[string]any{"type": "boolean"},
				"provider": map[string]any{"type": "string", "description": "The supported provider is cf_sfu."},
				"mode":     providerModeSchema(),
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
