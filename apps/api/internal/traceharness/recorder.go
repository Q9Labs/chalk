package traceharness

import (
	"encoding/json"
	"fmt"
	"io"
	"reflect"
	"sort"
	"strings"
	"sync"
	"time"
)

type Event struct {
	Number      int            `json:"number"`
	At          time.Time      `json:"at"`
	DurationMS  float64        `json:"duration_ms,omitempty"`
	Layer       string         `json:"layer"`
	Operation   string         `json:"operation"`
	Message     string         `json:"message"`
	Fields      map[string]any `json:"fields,omitempty"`
	Error       string         `json:"error,omitempty"`
	Failed      bool           `json:"failed,omitempty"`
	ParentEvent int            `json:"parent_event,omitempty"`
}

type TextOptions struct {
	Color bool
}

// Recorder stores a single scenario's ordered execution events.
type Recorder struct {
	mu     sync.Mutex
	now    func() time.Time
	events []Event
}

// Span records the start and return events for one traced operation.
type Span struct {
	recorder *Recorder
	number   int
	started  time.Time
}

// NewRecorder creates a scenario event recorder.
func NewRecorder(now func() time.Time) *Recorder {
	if now == nil {
		now = time.Now
	}

	return &Recorder{now: now}
}

// Add appends a point-in-time event to the trace.
func (r *Recorder) Add(layer string, operation string, message string, fields map[string]any) int {
	return r.add(Event{
		At:        r.now().UTC(),
		Layer:     layer,
		Operation: operation,
		Message:   message,
		Fields:    compactFields(fields),
	})
}

// Start appends a span start event and returns a handle for its return event.
func (r *Recorder) Start(layer string, operation string, message string, fields map[string]any) Span {
	started := r.now().UTC()
	number := r.add(Event{
		At:        started,
		Layer:     layer,
		Operation: operation,
		Message:   message,
		Fields:    compactFields(fields),
	})

	return Span{
		recorder: r,
		number:   number,
		started:  started,
	}
}

// End appends the return event for a span.
func (s Span) End(message string, fields map[string]any, err error) {
	if s.recorder == nil {
		return
	}

	now := s.recorder.now().UTC()
	event := Event{
		At:          now,
		DurationMS:  float64(now.Sub(s.started).Microseconds()) / 1000,
		Layer:       "return",
		Operation:   message,
		Message:     message,
		Fields:      compactFields(fields),
		ParentEvent: s.number,
	}
	if err != nil {
		event.Error = err.Error()
		event.Failed = true
	}

	s.recorder.add(event)
}

// Events returns the recorded events in insertion order.
func (r *Recorder) Events() []Event {
	r.mu.Lock()
	defer r.mu.Unlock()

	events := make([]Event, len(r.events))
	copy(events, r.events)
	return events
}

// WriteText writes a human-readable event timeline from a recorder.
func (r *Recorder) WriteText(w io.Writer) error {
	return WriteText(w, r.Events())
}

// WriteTextWithOptions writes a human-readable event timeline from a recorder.
func (r *Recorder) WriteTextWithOptions(w io.Writer, options TextOptions) error {
	return WriteTextWithOptions(w, r.Events(), options)
}

// WriteText writes a human-readable event timeline.
func WriteText(w io.Writer, events []Event) error {
	return WriteTextWithOptions(w, events, TextOptions{})
}

// WriteTextWithOptions writes a human-readable event timeline.
func WriteTextWithOptions(w io.Writer, events []Event, options TextOptions) error {
	theme := newTextTheme(options.Color)

	for _, event := range events {
		if err := writeTextEvent(w, theme, event); err != nil {
			return err
		}
	}

	return nil
}

// WriteJSON writes a JSON event timeline from a recorder.
func (r *Recorder) WriteJSON(w io.Writer) error {
	return WriteJSON(w, r.Events())
}

// WriteJSON writes a JSON event timeline.
func WriteJSON(w io.Writer, events []Event) error {
	encoder := json.NewEncoder(w)
	encoder.SetIndent("", "  ")
	return encoder.Encode(events)
}

func (r *Recorder) add(event Event) int {
	r.mu.Lock()
	defer r.mu.Unlock()

	event.Number = len(r.events) + 1
	r.events = append(r.events, event)
	return event.Number
}

func compactFields(fields map[string]any) map[string]any {
	if len(fields) == 0 {
		return nil
	}

	compacted := make(map[string]any, len(fields))
	for key, value := range fields {
		if value != nil {
			compacted[key] = value
		}
	}
	if len(compacted) == 0 {
		return nil
	}

	return compacted
}

func sortedKeys(fields map[string]any) []string {
	keys := make([]string, 0, len(fields))
	for key := range fields {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

type textTheme struct {
	enabled bool
	reset   string
	dim     string
	bold    string
	red     string
	green   string
	cyan    string
	yellow  string
	magenta string
	blue    string
}

func newTextTheme(enabled bool) textTheme {
	if !enabled {
		return textTheme{}
	}

	return textTheme{
		enabled: true,
		reset:   "\x1b[0m",
		dim:     "\x1b[2m",
		bold:    "\x1b[1m",
		red:     "\x1b[31m",
		green:   "\x1b[32m",
		cyan:    "\x1b[36m",
		yellow:  "\x1b[33m",
		magenta: "\x1b[35m",
		blue:    "\x1b[34m",
	}
}

func (t textTheme) paint(style string, value string) string {
	if !t.enabled || style == "" {
		return value
	}

	return style + value + t.reset
}

func writeTextEvent(w io.Writer, theme textTheme, event Event) error {
	status := "CALL"
	statusColor := theme.cyan
	if event.ParentEvent > 0 {
		status = "RET"
		statusColor = theme.green
	}
	if event.Failed {
		status = "ERR"
		statusColor = theme.red
	}

	meta := ""
	if event.ParentEvent > 0 {
		meta = fmt.Sprintf(" from #%02d", event.ParentEvent)
	}
	if event.DurationMS > 0 {
		meta += fmt.Sprintf(" %.3fms", event.DurationMS)
	}
	if meta != "" {
		meta = "  " + theme.paint(theme.dim, strings.TrimSpace(meta))
	}
	if event.Error != "" {
		meta += "  " + theme.paint(theme.red, event.Error)
	}

	if _, err := fmt.Fprintf(
		w,
		"%s %s %s %s%s\n",
		theme.paint(theme.dim, fmt.Sprintf("%02d", event.Number)),
		theme.paint(statusColor, fmt.Sprintf("%-4s", status)),
		theme.paint(layerColor(theme, event.Layer), fmt.Sprintf("%-10s", event.Layer)),
		theme.paint(theme.bold, event.Operation),
		meta,
	); err != nil {
		return err
	}

	if _, err := fmt.Fprintf(w, "     %s\n", event.Message); err != nil {
		return err
	}
	if len(event.Fields) == 0 {
		_, err := fmt.Fprintln(w)
		return err
	}

	for _, key := range sortedKeys(event.Fields) {
		if err := writeField(w, theme, "     ", key, event.Fields[key]); err != nil {
			return err
		}
	}
	_, err := fmt.Fprintln(w)
	return err
}

func layerColor(theme textTheme, layer string) string {
	switch layer {
	case "scenario":
		return theme.magenta
	case "http":
		return theme.blue
	case "auth":
		return theme.yellow
	case "service":
		return theme.cyan
	case "repository":
		return theme.magenta
	case "database":
		return theme.green
	case "return":
		return theme.green
	default:
		return ""
	}
}

func writeField(w io.Writer, theme textTheme, indent string, key string, value any) error {
	value = dereference(value)

	switch typed := value.(type) {
	case nil:
		_, err := fmt.Fprintf(w, "%s%s: %s\n", indent, theme.paint(theme.dim, key), theme.paint(theme.dim, "null"))
		return err
	case map[string]any:
		if _, err := fmt.Fprintf(w, "%s%s\n", indent, theme.paint(theme.dim, key)); err != nil {
			return err
		}
		for _, childKey := range sortedKeys(typed) {
			if err := writeField(w, theme, indent+"  ", childKey, typed[childKey]); err != nil {
				return err
			}
		}
		return nil
	}

	reflected := reflect.ValueOf(value)
	switch reflected.Kind() {
	case reflect.Map:
		normalized, err := stringMap(value)
		if err != nil {
			return err
		}
		return writeField(w, theme, indent, key, normalized)
	case reflect.Slice, reflect.Array:
		if _, err := fmt.Fprintf(w, "%s%s\n", indent, theme.paint(theme.dim, key)); err != nil {
			return err
		}
		for index := range reflected.Len() {
			item := dereference(reflected.Index(index).Interface())
			if isScalar(item) {
				if _, err := fmt.Fprintf(w, "%s  - %s\n", indent, scalarString(theme, item)); err != nil {
					return err
				}
				continue
			}
			if _, err := fmt.Fprintf(w, "%s  -\n", indent); err != nil {
				return err
			}
			if err := writeField(w, theme, indent+"    ", "value", item); err != nil {
				return err
			}
		}
		return nil
	}

	_, err := fmt.Fprintf(w, "%s%s: %s\n", indent, theme.paint(theme.dim, key), scalarString(theme, value))
	return err
}

func dereference(value any) any {
	if value == nil {
		return nil
	}

	reflected := reflect.ValueOf(value)
	for reflected.Kind() == reflect.Pointer {
		if reflected.IsNil() {
			return nil
		}
		reflected = reflected.Elem()
	}

	return reflected.Interface()
}

func stringMap(value any) (map[string]any, error) {
	reflected := reflect.ValueOf(value)
	if reflected.Kind() != reflect.Map || reflected.Type().Key().Kind() != reflect.String {
		return nil, fmt.Errorf("trace field map keys must be strings")
	}

	result := make(map[string]any, reflected.Len())
	iter := reflected.MapRange()
	for iter.Next() {
		result[iter.Key().String()] = iter.Value().Interface()
	}
	return result, nil
}

func isScalar(value any) bool {
	switch dereference(value).(type) {
	case nil, string, bool, int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, float32, float64:
		return true
	}

	reflected := reflect.ValueOf(dereference(value))
	switch reflected.Kind() {
	case reflect.String, reflect.Bool, reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64, reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Float32, reflect.Float64:
		return true
	default:
		return false
	}
}

func scalarString(theme textTheme, value any) string {
	value = dereference(value)
	switch typed := value.(type) {
	case nil:
		return theme.paint(theme.dim, "null")
	case string:
		return stringValue(theme, typed)
	case bool:
		return fmt.Sprintf("%t", typed)
	case fmt.Stringer:
		return typed.String()
	}

	reflected := reflect.ValueOf(value)
	switch reflected.Kind() {
	case reflect.String:
		return stringValue(theme, reflected.String())
	case reflect.Bool:
		return fmt.Sprintf("%t", reflected.Bool())
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return fmt.Sprintf("%d", reflected.Int())
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return fmt.Sprintf("%d", reflected.Uint())
	case reflect.Float32, reflect.Float64:
		return fmt.Sprintf("%v", reflected.Float())
	default:
		return fmt.Sprintf("%v", value)
	}
}

func stringValue(theme textTheme, value string) string {
	if value == "" {
		return theme.paint(theme.dim, `""`)
	}
	if strings.TrimSpace(value) != value || strings.ContainsAny(value, "\n\t") {
		encoded, err := json.Marshal(value)
		if err == nil {
			return string(encoded)
		}
	}

	return value
}
