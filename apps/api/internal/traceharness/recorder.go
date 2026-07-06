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
	// Tree renders nesting with box-drawing guides instead of flat indentation.
	Tree bool
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

	originLayers := make(map[int]string, len(events))
	for _, event := range events {
		originLayers[event.Number] = event.Layer
	}

	for _, event := range events {
		if err := writeTextEvent(w, theme, options.Tree, originLayers, event); err != nil {
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
	enabled       bool
	reset         string
	dim           string
	bold          string
	red           string
	green         string
	cyan          string
	yellow        string
	magenta       string
	brightMagenta string
	blue          string
}

func newTextTheme(enabled bool) textTheme {
	if !enabled {
		return textTheme{}
	}

	return textTheme{
		enabled:       true,
		reset:         "\x1b[0m",
		dim:           "\x1b[2m",
		bold:          "\x1b[1m",
		red:           "\x1b[31m",
		green:         "\x1b[32m",
		cyan:          "\x1b[36m",
		yellow:        "\x1b[33m",
		magenta:       "\x1b[35m",
		brightMagenta: "\x1b[95m",
		blue:          "\x1b[34m",
	}
}

func (t textTheme) paint(style string, value string) string {
	if !t.enabled || style == "" {
		return value
	}

	return style + value + t.reset
}

func writeTextEvent(w io.Writer, theme textTheme, tree bool, originLayers map[int]string, event Event) error {
	status, statusStyle := eventStatus(theme, event)

	// A return event belongs to the layer that opened it; show that origin
	// rather than the internal "return" marker so the badge stays meaningful.
	layer := event.Layer
	if event.ParentEvent > 0 {
		if origin, ok := originLayers[event.ParentEvent]; ok {
			layer = origin
		}
	}

	if _, err := fmt.Fprintf(
		w,
		"%s  %s  %s %s%s\n",
		theme.paint(theme.dim, fmt.Sprintf("%02d", event.Number)),
		theme.paint(statusStyle, fmt.Sprintf("%-4s", status)),
		theme.paint(layerColor(theme, layer), fmt.Sprintf("%-10s", layer)),
		theme.paint(theme.bold, event.Operation),
		eventMeta(theme, event),
	); err != nil {
		return err
	}

	// Skip the description when it only repeats the bold summary (return events
	// reuse their message as the operation).
	if event.Message != "" && event.Message != event.Operation {
		gutter := "    "
		if tree && len(event.Fields) > 0 {
			gutter = " " + theme.paint(theme.dim, "│") + "  "
		}
		if _, err := fmt.Fprintf(w, "%s%s\n", gutter, event.Message); err != nil {
			return err
		}
	}

	if len(event.Fields) > 0 {
		if err := writeFieldGroup(w, theme, tree, fieldRoot(tree), event.Fields); err != nil {
			return err
		}
	}

	_, err := fmt.Fprintln(w)
	return err
}

func eventStatus(theme textTheme, event Event) (string, string) {
	switch {
	case event.Failed:
		return "ERR", theme.bold + theme.red
	case event.ParentEvent > 0:
		return "RET", theme.green
	default:
		return "CALL", theme.dim
	}
}

func eventMeta(theme textTheme, event Event) string {
	parts := make([]string, 0, 2)
	if event.DurationMS > 0 {
		parts = append(parts, fmt.Sprintf("%.3fms", event.DurationMS))
	}
	if event.ParentEvent > 0 {
		parts = append(parts, fmt.Sprintf("#%02d", event.ParentEvent))
	}

	meta := ""
	if len(parts) > 0 {
		meta = "  " + theme.paint(theme.dim, strings.Join(parts, " · "))
	}
	if event.Error != "" {
		meta += "  " + theme.paint(theme.red, event.Error)
	}
	return meta
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
		return theme.brightMagenta
	case "database":
		return theme.green
	default:
		return ""
	}
}

// fieldRoot is the left gutter that field lines start from: a single leading
// space for tree guides, or a four-space indent for flat nesting.
func fieldRoot(tree bool) string {
	if tree {
		return " "
	}
	return "    "
}

func writeFieldGroup(w io.Writer, theme textTheme, tree bool, bars string, fields map[string]any) error {
	keys := sortedKeys(fields)
	pad := scalarKeyWidth(fields, keys)
	for index, key := range keys {
		last := index == len(keys)-1
		if err := writeFieldNode(w, theme, tree, bars, last, key, fields[key], pad); err != nil {
			return err
		}
	}
	return nil
}

func writeFieldNode(w io.Writer, theme textTheme, tree bool, bars string, last bool, key string, value any, pad int) error {
	value = dereference(value)
	connector := nodeConnector(theme, tree, last)
	childBars := bars + childBars(theme, tree, last)

	switch typed := value.(type) {
	case nil:
		return writeScalarLine(w, theme, bars, connector, key, pad, theme.paint(theme.dim, "null"))
	case map[string]any:
		if _, err := fmt.Fprintf(w, "%s%s%s\n", bars, connector, theme.paint(theme.dim, key)); err != nil {
			return err
		}
		return writeFieldGroup(w, theme, tree, childBars, typed)
	}

	reflected := reflect.ValueOf(value)
	switch reflected.Kind() {
	case reflect.Map:
		normalized, err := stringMap(value)
		if err != nil {
			return err
		}
		return writeFieldNode(w, theme, tree, bars, last, key, normalized, pad)
	case reflect.Slice, reflect.Array:
		if _, err := fmt.Fprintf(w, "%s%s%s\n", bars, connector, theme.paint(theme.dim, key)); err != nil {
			return err
		}
		return writeSliceItems(w, theme, tree, childBars, reflected)
	}

	return writeScalarLine(w, theme, bars, connector, key, pad, scalarString(theme, value))
}

func writeSliceItems(w io.Writer, theme textTheme, tree bool, bars string, reflected reflect.Value) error {
	length := reflected.Len()
	for index := range length {
		last := index == length-1
		item := dereference(reflected.Index(index).Interface())
		connector := itemConnector(theme, tree, last)
		if isScalar(item) {
			if _, err := fmt.Fprintf(w, "%s%s%s\n", bars, connector, scalarString(theme, item)); err != nil {
				return err
			}
			continue
		}

		normalized, ok := item.(map[string]any)
		if !ok {
			mapped, err := stringMap(item)
			if err != nil {
				if _, err := fmt.Fprintf(w, "%s%s%s\n", bars, connector, scalarString(theme, item)); err != nil {
					return err
				}
				continue
			}
			normalized = mapped
		}
		if _, err := fmt.Fprintf(w, "%s%s\n", bars, connector); err != nil {
			return err
		}
		if err := writeFieldGroup(w, theme, tree, bars+childBars(theme, tree, last), normalized); err != nil {
			return err
		}
	}
	return nil
}

// writeScalarLine renders "key   value", padding the key so sibling values line
// up. Padding is applied to the plain key before any color codes so the visible
// columns stay aligned.
func writeScalarLine(w io.Writer, theme textTheme, bars string, connector string, key string, pad int, value string) error {
	label := key
	if width := len([]rune(key)); width < pad {
		label += strings.Repeat(" ", pad-width)
	}
	_, err := fmt.Fprintf(w, "%s%s%s  %s\n", bars, connector, theme.paint(theme.dim, label), value)
	return err
}

// scalarKeyWidth is the longest key among a group's scalar-valued entries, used
// to align their values into a column.
func scalarKeyWidth(fields map[string]any, keys []string) int {
	width := 0
	for _, key := range keys {
		if !isScalar(fields[key]) {
			continue
		}
		if runes := len([]rune(key)); runes > width {
			width = runes
		}
	}
	return width
}

func nodeConnector(theme textTheme, tree bool, last bool) string {
	if !tree {
		return ""
	}
	if last {
		return theme.paint(theme.dim, "└─ ")
	}
	return theme.paint(theme.dim, "├─ ")
}

func itemConnector(theme textTheme, tree bool, last bool) string {
	if !tree {
		return theme.paint(theme.dim, "- ")
	}
	return nodeConnector(theme, tree, last)
}

func childBars(theme textTheme, tree bool, last bool) string {
	if !tree {
		return "  "
	}
	if last {
		return "   "
	}
	return theme.paint(theme.dim, "│") + "  "
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
