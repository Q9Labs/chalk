package traceharness

import (
	"encoding/json"
	"fmt"
	"io"
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

// WriteText writes a human-readable event timeline.
func WriteText(w io.Writer, events []Event) error {
	for _, event := range events {
		line := fmt.Sprintf("%02d  %-12s %-34s %s", event.Number, event.Layer, event.Operation, event.Message)
		if event.ParentEvent > 0 {
			line += fmt.Sprintf(" (from #%02d", event.ParentEvent)
			if event.DurationMS > 0 {
				line += fmt.Sprintf(", %.3fms", event.DurationMS)
			}
			line += ")"
		}
		if event.Error != "" {
			line += " error=" + event.Error
		}

		if _, err := fmt.Fprintln(w, line); err != nil {
			return err
		}
		for _, key := range sortedKeys(event.Fields) {
			value, err := json.MarshalIndent(event.Fields[key], "      ", "  ")
			if err != nil {
				return fmt.Errorf("encode field %q: %w", key, err)
			}
			if _, err := fmt.Fprintf(w, "    %s: %s\n", key, strings.TrimSpace(string(value))); err != nil {
				return err
			}
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
