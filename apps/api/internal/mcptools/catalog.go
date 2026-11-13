package mcptools

import (
	"encoding/json"
	"maps"
	"reflect"
	"slices"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
)

// Kind says what a tool does to the tenant, which fixes its MCP annotations and
// whether its result can be read in fragments.
type Kind uint8

const (
	// KindRead only reads. Its result may be fetched in fragments with result_offset.
	KindRead Kind = iota
	// KindAppend adds something and changes nothing that exists.
	KindAppend
	// KindMutate changes or deletes something that exists.
	KindMutate
)

// Action is one value of a tool's selector: the fields that value needs besides
// the selector, and the scope it needs when that differs from the tool's own.
type Action struct {
	Needs []string
	Scope authentication.Scope
}

// Tool is one MCP tool: the schema the model sees, the scope each call needs, and
// the per-action field rules, all declared in one value. Bind adds the handler.
type Tool struct {
	Name        string
	Description string
	Kind        Kind
	// Scope is the scope a call needs unless its Action names another.
	Scope  authentication.Scope
	Schema *Schema
	// Selector names the argument that picks what a call does: "action" for tools
	// that change things, "view" for inspect tools. A call that omits it gets Default.
	// A tool without Actions has no selector.
	Selector string
	Default  string
	Actions  map[string]Action
	// Untrusted marks results that carry text written by call participants.
	Untrusted bool
	// profile marks the tool ChatGPT-style clients call to identify the connection.
	profile bool
}

func newTool(name, description string, kind Kind, scope authentication.Scope, properties map[string]*Schema, required []string) Tool {
	if kind == KindRead {
		properties["result_offset"] = integer(0, 1<<30)
	}
	return Tool{Name: name, Description: description, Kind: kind, Scope: scope, Schema: object(properties, required...)}
}

// Read declares a tool that only reads. Its input must embed ReadInput.
func Read(name, description string, scope authentication.Scope, properties map[string]*Schema, required ...string) Tool {
	return newTool(name, description, KindRead, scope, properties, required)
}

// Append declares a tool that adds something and changes nothing that exists.
func Append(name, description string, scope authentication.Scope, properties map[string]*Schema, required ...string) Tool {
	return newTool(name, description, KindAppend, scope, properties, required)
}

// Mutate declares a tool that changes or deletes something that exists.
func Mutate(name, description string, scope authentication.Scope, properties map[string]*Schema, required ...string) Tool {
	return newTool(name, description, KindMutate, scope, properties, required)
}

// ProfileTool declares the tool that identifies the connection's tenant. Its result
// is the standard profile object, so it takes no arguments and never fragments.
func ProfileTool(name, description string, scope authentication.Scope) Tool {
	tool := Tool{Name: name, Description: description, Kind: KindRead, Scope: scope, Schema: object(map[string]*Schema{})}
	tool.profile = true
	return tool
}

// WithActions makes action the selector of a tool that does several things.
// Anthropic's API refuses a top-level anyOf, so the schema stays a plain object,
// the description tells the model the per-action rules, and a call that omits a
// field its action needs is rejected before dispatch.
func (t Tool) WithActions(actions map[string]Action) Tool {
	t.Selector, t.Actions = "action", actions
	rules := make([]string, 0, len(actions))
	for _, name := range slices.Sorted(maps.Keys(actions)) {
		needs := "no other field"
		if fields := actions[name].Needs; len(fields) > 0 {
			needs = strings.Join(fields, ", ")
		}
		rules = append(rules, name+": "+needs)
	}
	t.Description += " Fields required besides action, by action (" + strings.Join(rules, "; ") + ")."
	return t
}

// WithViews makes view the selector of an inspect tool. A call may omit it and
// get def, and each view lists the fields it needs besides the view itself.
func (t Tool) WithViews(def string, views map[string]Action) Tool {
	t.Selector, t.Default, t.Actions = "view", def, views
	var rules []string
	for _, name := range slices.Sorted(maps.Keys(views)) {
		if fields := views[name].Needs; len(fields) > 0 {
			rules = append(rules, name+": "+strings.Join(fields, ", "))
		}
	}
	if len(rules) > 0 {
		t.Description += " Fields required by view (" + strings.Join(rules, "; ") + ")."
	}
	return t
}

// WithUntrustedResults marks the tool's results as text written by call participants.
func (t Tool) WithUntrustedResults() Tool {
	t.Untrusted = true
	return t
}

// ScopeFor names the scope one call needs, given its selector value. Reads that
// share a tool with writes, and views of different resources, need different scopes.
func (t Tool) ScopeFor(selected string) authentication.Scope {
	if action, ok := t.Actions[selected]; ok && action.Scope != "" {
		return action.Scope
	}
	return t.Scope
}

// callable says whether a connection can make at least one call to this tool. It
// decides what tools/list shows; each call is still checked.
func (t Tool) callable(c Connection) bool {
	if c.Holds(t.Scope) {
		return true
	}
	return slices.ContainsFunc(slices.Collect(maps.Values(t.Actions)), func(a Action) bool { return a.Scope != "" && c.Holds(a.Scope) })
}

// selected returns the selector value of a call's arguments, or Default when the
// call omits it and the tool has one.
func (t Tool) selected(arguments map[string]json.RawMessage) (string, bool) {
	var value string
	if raw, present := arguments[t.Selector]; present {
		return value, json.Unmarshal(raw, &value) == nil
	}
	return t.Default, t.Default != ""
}

// checkArguments returns the call's selector value and rejects a call that omits a
// field that value needs. The schema cannot say this without a top-level anyOf.
func (t Tool) checkArguments(raw json.RawMessage) (string, error) {
	if t.Actions == nil {
		return "", nil
	}
	var arguments map[string]json.RawMessage
	if json.Unmarshal(raw, &arguments) != nil {
		return "", Error{Code: "mcp.invalid_arguments", Message: "Arguments must be an object."}
	}
	value, ok := t.selected(arguments)
	if !ok {
		return "", Error{Code: "mcp.invalid_arguments", Message: "Arguments must include a string " + t.Selector + "."}
	}
	action, known := t.Actions[value]
	if !known {
		return "", Error{Code: "mcp.invalid_arguments", Message: "Unknown " + t.Selector + ": " + value}
	}
	missing := slices.DeleteFunc(slices.Clone(action.Needs), func(field string) bool { _, present := arguments[field]; return present })
	if len(missing) > 0 {
		return "", Error{Code: "mcp.invalid_arguments", Message: strings.ToUpper(t.Selector[:1]) + t.Selector[1:] + " " + value + " also requires: " + strings.Join(missing, ", ")}
	}
	return value, nil
}

func (t Tool) mcpTool() *mcp.Tool {
	destructive := t.Kind == KindMutate
	read := t.Kind == KindRead
	tool := &mcp.Tool{Name: "chalk_" + t.Name, Description: t.Description, InputSchema: t.Schema, Annotations: &mcp.ToolAnnotations{ReadOnlyHint: read, DestructiveHint: &destructive, IdempotentHint: read}}
	if t.profile {
		tool.Meta = mcp.Meta{"openai/profile": true}
		tool.OutputSchema = object(map[string]*Schema{"id": {Type: "string", MinLength: 1, Pattern: `\S`}, "name": text("Profile display name")}, "id")
		tool.Annotations.OpenWorldHint = new(bool)
	}
	return tool
}

// checkInput panics when the tool's schema and the Go input it is bound to
// disagree, so a typo in either fails at startup instead of rejecting calls.
func (t Tool) checkInput(input reflect.Type) {
	fields := jsonFields(input)
	for name := range t.Schema.Properties {
		if !fields[name] {
			panic("mcptools: tool " + t.Name + " declares property " + name + " that " + input.String() + " does not decode")
		}
	}
	for name, action := range t.Actions {
		for _, field := range action.Needs {
			if t.Schema.Properties[field] == nil {
				panic("mcptools: tool " + t.Name + " action " + name + " needs " + field + ", which the schema does not declare")
			}
		}
	}
	if t.Selector != "" && t.Schema.Properties[t.Selector] == nil {
		panic("mcptools: tool " + t.Name + " has no " + t.Selector + " property")
	}
}

// jsonFields lists the JSON names a struct decodes, including promoted fields.
func jsonFields(t reflect.Type) map[string]bool {
	names := map[string]bool{}
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	if t.Kind() != reflect.Struct {
		return names
	}
	for i := range t.NumField() {
		field := t.Field(i)
		name, _, _ := strings.Cut(field.Tag.Get("json"), ",")
		switch {
		case name == "-":
		case field.Anonymous && name == "":
			maps.Copy(names, jsonFields(field.Type))
		case name != "":
			names[name] = true
		default:
			names[field.Name] = true
		}
	}
	return names
}
