package sdktelemetry

import (
	"reflect"
	"slices"
	"strings"
)

// Check returns the reason the event is invalid, or an empty string. The reason is
// a fixed label built from a field name and a rule.
func (e Event) Check() string {
	spec, ok := specs[e.Type]
	if !ok {
		return "type"
	}
	if e.Seq < 0 || e.Seq > MaxMilliseconds || e.ElapsedMS < 0 || e.ElapsedMS > MaxMilliseconds {
		return "elapsed_range"
	}
	present := e.presentFields()
	for _, name := range present {
		if !slices.Contains(spec.allowed, name) {
			return name + "_not_allowed"
		}
	}
	for _, name := range spec.required {
		if !slices.Contains(present, name) {
			return name + "_missing"
		}
	}
	if reason := checkValues(reflect.ValueOf(e), ""); reason != "" {
		return reason
	}
	for _, dropped := range e.DroppedSeqs {
		if dropped.From >= dropped.To {
			return "dropped_seqs_order"
		}
	}
	if e.Stats != nil {
		return e.Stats.check()
	}
	return ""
}

// presentFields lists the JSON names of the optional fields the event sets.
func (e Event) presentFields() []string {
	var names []string
	value := reflect.ValueOf(e)
	for index := range value.NumField() {
		field := reflect.TypeFor[Event]().Field(index)
		name, optional := jsonName(field)
		if optional && name != "event_id" && !value.Field(index).IsZero() {
			names = append(names, name)
		}
	}
	return names
}

func jsonName(field reflect.StructField) (name string, optional bool) {
	tag, ok := field.Tag.Lookup("json")
	if !ok {
		return "", false
	}
	name, options, _ := strings.Cut(tag, ",")
	return name, options == "omitempty"
}

// checkValues checks every set field against its enum, its range and its pattern.
func checkValues(value reflect.Value, prefix string) string {
	for index := range value.NumField() {
		field := value.Type().Field(index)
		name, _ := jsonName(field)
		if name == "" || value.Field(index).IsZero() {
			continue
		}
		if reason := checkField(name, value.Field(index)); reason != "" {
			return prefix + reason
		}
	}
	return ""
}

func checkField(name string, value reflect.Value) string {
	switch value.Kind() {
	case reflect.Pointer:
		return checkField(name, value.Elem())
	case reflect.String:
		return checkString(name, value.String())
	case reflect.Int64:
		return checkNumber(name, float64(value.Int()))
	case reflect.Float64:
		return checkNumber(name, value.Float())
	case reflect.Struct:
		return checkValues(value, name+".")
	case reflect.Slice:
		if value.Len() > sliceLimit(name) {
			return name + "_count"
		}
		for index := range value.Len() {
			if reason := checkValues(value.Index(index), name+"."); reason != "" {
				return reason
			}
		}
	}
	return ""
}

// sliceLimit is the most items a list field may hold.
func sliceLimit(name string) int {
	if name == "dropped_seqs" {
		return MaxDropRanges
	}
	return MaxTracks
}

func checkString(name, value string) string {
	switch name {
	case "op_id", "event_id":
		if !uuidPattern.MatchString(value) {
			return name + "_label"
		}
	case "mid":
		if !midPattern.MatchString(value) {
			return name + "_label"
		}
	default:
		if enum := FieldEnum(name); enum != nil && !slices.Contains(enum, value) {
			return name + "_label"
		}
	}
	return ""
}

func checkNumber(name string, value float64) string {
	low, high, numeric := FieldRange(name)
	if !numeric || value < low || value > high {
		return name + "_range"
	}
	return ""
}
