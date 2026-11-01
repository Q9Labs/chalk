package mcpapi

// Schema is the small JSON Schema vocabulary used by the curated tool catalog.
// It is deliberately independent of application and storage types.
type Schema struct {
	Type                 string             `json:"type,omitempty"`
	Description          string             `json:"description,omitempty"`
	Properties           map[string]*Schema `json:"properties,omitempty"`
	Required             []string           `json:"required,omitempty"`
	AdditionalProperties *bool              `json:"additionalProperties,omitempty"`
	Items                *Schema            `json:"items,omitempty"`
	Enum                 []string           `json:"enum,omitempty"`
	Minimum              *int               `json:"minimum,omitempty"`
	Maximum              *int               `json:"maximum,omitempty"`
	MaxLength            int                `json:"maxLength,omitempty"`
	MinLength            int                `json:"minLength,omitempty"`
	MaxItems             int                `json:"maxItems,omitempty"`
	MinItems             int                `json:"minItems,omitempty"`
	AnyOf                []*Schema          `json:"anyOf,omitempty"`
}

func object(p map[string]*Schema, required ...string) *Schema {
	no := false
	return &Schema{Type: "object", Properties: p, Required: required, AdditionalProperties: &no}
}
func text(description string) *Schema {
	return &Schema{Type: "string", Description: description, MaxLength: 4096}
}
func choice(values ...string) *Schema { return &Schema{Type: "string", Enum: values} }
func integer(min, max int) *Schema    { return &Schema{Type: "integer", Minimum: &min, Maximum: &max} }
func boolean() *Schema                { return &Schema{Type: "boolean"} }
func nullable(s *Schema) *Schema      { return &Schema{AnyOf: []*Schema{s, {Type: "null"}}} }
func id() *Schema {
	return &Schema{Type: "string", MinLength: 36, MaxLength: 36, Description: "Chalk UUID; must belong to this connection's tenant."}
}
func stringsSchema(max int) *Schema { return &Schema{Type: "array", Items: text(""), MaxItems: max} }
func fields(pairs ...string) map[string]*Schema {
	p := map[string]*Schema{}
	for _, name := range pairs {
		p[name] = text("")
	}
	return p
}
func page(p map[string]*Schema) map[string]*Schema {
	p["page_size"] = integer(1, 50)
	p["cursor"] = text("Use pagination.next_cursor from the previous page.")
	return p
}
func read(p map[string]*Schema) map[string]*Schema { p["result_offset"] = integer(0, 16<<20); return p }
func requestKey(p map[string]*Schema) map[string]*Schema {
	p["request_key"] = text("Caller-supplied idempotency key, preserved unchanged on retries.")
	return p
}
func bodySchema(p map[string]*Schema, required ...string) *Schema { return object(p, required...) }
func spaceSettings(create bool) *Schema {
	p := fields("name", "slug", "media_plane", "recording_policy", "transcription_policy")
	for _, k := range []string{"metadata", "recurring_policy", "admission_policy"} {
		p[k] = &Schema{}
	}
	for _, k := range []string{"default_episode_duration_seconds", "maximum_episode_duration_seconds", "linger_window_seconds"} {
		p[k] = integer(0, 2147483647)
	}
	if create {
		return object(p, "name", "slug")
	}
	return object(p)
}
func tenantSettings() *Schema {
	p := fields("name", "recording_render_mode", "default_media_plane", "logo_key", "website", "transcription_ceiling", "transcription_default_mode", "provider_policy_version")
	for _, k := range []string{"media_plane_provider_config", "storage_provider_config"} {
		p[k] = &Schema{}
	}
	p["cors_allowed_origins"] = stringsSchema(100)
	for _, k := range []string{"recording_retention_seconds", "transcript_retention_seconds", "transcription_source_window_seconds"} {
		p[k] = integer(0, 2147483647)
	}
	return object(p)
}
func webhookSettings(create bool) *Schema {
	p := fields("name", "url")
	p["enabled"] = boolean()
	p["api_version"] = integer(1, 2147483647)
	p["event_types"] = stringsSchema(100)
	if create {
		return object(p, "name", "url", "enabled", "event_types")
	}
	return object(p)
}
