package mcpapi

import (
	"encoding"
	"encoding/json"
	"maps"
	"reflect"
	"slices"
	"strconv"
	"strings"
)

const typeScriptPrelude = `// Generated from the curated MCP schemas and bound application response types.
// Dynamic JSON (metadata and action-dependent responses) is intentionally JSONValue.
type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };
type ChalkResult<T> = { ok: true; result: T } | { ok: false; error: { code: string; message: string } };
type ChalkData<T> = { source: string; data?: T; total_bytes: number; json_fragment?: string; next_offset?: number; notice?: string };
declare namespace chalk {
`

func operationTypeScript(d Definition) string {
	result := "JSONValue"
	if d.ResultType != nil {
		result = goTypeScript(d.ResultType, 0)
	}
	if d.Name != GetConnection.Name {
		result = "ChalkData<" + result + ">"
	}
	return "/** " + safeDoc(d.Description) + " Required scope: " + d.Scope + ". */\n" +
		"function " + d.Name + "(args: " + schemaTypeScript(d.Schema) + "): Promise<ChalkResult<" + result + ">>;\n"
}

func safeDoc(s string) string { return strings.ReplaceAll(s, "*/", "* /") }

func schemaTypeScript(s *Schema) string {
	if s == nil {
		return "JSONValue"
	}
	if len(s.Enum) > 0 {
		values := []string{}
		for _, v := range s.Enum {
			values = append(values, strconv.Quote(v))
		}
		return strings.Join(values, " | ")
	}
	base := ""
	switch s.Type {
	case "string":
		base = "string"
	case "integer", "number":
		base = "number"
	case "boolean":
		base = "boolean"
	case "null":
		base = "null"
	case "array":
		base = "(" + schemaTypeScript(s.Items) + ")[]"
	}
	if s.Type == "object" || s.Properties != nil {
		fields := []string{}
		for _, name := range slices.Sorted(maps.Keys(s.Properties)) {
			field := s.Properties[name]
			doc := ""
			if field.Description != "" {
				doc = "/** " + safeDoc(field.Description) + " */ "
			}
			optional := "?"
			if slices.Contains(s.Required, name) {
				optional = ""
			}
			fields = append(fields, doc+strconv.Quote(name)+optional+": "+schemaTypeScript(field))
		}
		base = "{ " + strings.Join(fields, "; ") + " }"
	}
	if len(s.AnyOf) > 0 {
		options := []string{}
		for _, item := range s.AnyOf {
			options = append(options, schemaTypeScript(item))
		}
		union := "(" + strings.Join(options, " | ") + ")"
		if base != "" {
			return base + " & " + union
		}
		return union
	}
	if base == "" {
		return "JSONValue"
	}
	return base
}

// Render actual JSON field names from response types, including embedded fields.
// Open metadata, custom JSON encodings and recursive shapes remain JSONValue.
func goTypeScript(t reflect.Type, depth int) string {
	if depth > 12 {
		return "JSONValue"
	}
	if t.Kind() == reflect.Pointer {
		return "(" + goTypeScript(t.Elem(), depth+1) + " | null)"
	}
	if t == reflect.TypeFor[json.RawMessage]() {
		return "JSONValue"
	}
	if t.Implements(reflect.TypeFor[encoding.TextMarshaler]()) {
		return "string"
	}
	if t.Implements(reflect.TypeFor[json.Marshaler]()) {
		return "JSONValue"
	}
	switch t.Kind() {
	case reflect.String:
		return "string"
	case reflect.Bool:
		return "boolean"
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64, reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Float32, reflect.Float64:
		return "number"
	case reflect.Array, reflect.Slice:
		return "(" + goTypeScript(t.Elem(), depth+1) + ")[]"
	case reflect.Map:
		return "{ [key: string]: " + goTypeScript(t.Elem(), depth+1) + " }"
	case reflect.Struct:
		fields := []string{}
		embedded := []string{}
		for i := 0; i < t.NumField(); i++ {
			f := t.Field(i)
			if !f.IsExported() {
				continue
			}
			tag := strings.Split(f.Tag.Get("json"), ",")
			if tag[0] == "-" {
				continue
			}
			if f.Anonymous && tag[0] == "" {
				embedded = append(embedded, goTypeScript(f.Type, depth+1))
				continue
			}
			name := tag[0]
			if name == "" {
				name = f.Name
			}
			optional := ""
			if slices.Contains(tag[1:], "omitempty") || slices.Contains(tag[1:], "omitzero") {
				optional = "?"
			}
			fields = append(fields, strconv.Quote(name)+optional+": "+goTypeScript(f.Type, depth+1))
		}
		return strings.Join(append([]string{"{ " + strings.Join(fields, "; ") + " }"}, embedded...), " & ")
	default:
		return "JSONValue"
	}
}
