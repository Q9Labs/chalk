package ops

import (
	"fmt"
	"strings"
	"time"
)

type MonitorKind string

const (
	MonitorKindExternalHTTP MonitorKind = "external_http"
	MonitorKindSynthetic    MonitorKind = "synthetic"
)

func (k MonitorKind) IsValid() bool {
	switch k {
	case MonitorKindExternalHTTP, MonitorKindSynthetic:
		return true
	default:
		return false
	}
}

type ComponentDefinition struct {
	Key           ComponentKey
	DisplayName   string
	Description   string
	PublicVisible bool
}

func (d ComponentDefinition) Validate() error {
	if !d.Key.IsValid() {
		return fmt.Errorf("%w: component key %q", ErrInvalidCatalogDefinition, d.Key)
	}
	if strings.TrimSpace(d.DisplayName) == "" {
		return fmt.Errorf("%w: component display_name required for %q", ErrInvalidCatalogDefinition, d.Key)
	}
	return nil
}

type MonitorDefinition struct {
	Key                         MonitorKey
	Kind                        MonitorKind
	DisplayName                 string
	Description                 string
	ComponentKey                ComponentKey
	Severity                    IncidentSeverity
	ExpectedInterval            time.Duration
	AutoOpenConsecutiveFailures int
	HTTPMethod                  string
	HTTPPath                    string
}

func (d MonitorDefinition) Validate() error {
	if !d.Key.IsValid() {
		return fmt.Errorf("%w: monitor key %q", ErrInvalidCatalogDefinition, d.Key)
	}
	if !d.Kind.IsValid() {
		return fmt.Errorf("%w: monitor kind %q for %q", ErrInvalidCatalogDefinition, d.Kind, d.Key)
	}
	if strings.TrimSpace(d.DisplayName) == "" {
		return fmt.Errorf("%w: monitor display_name required for %q", ErrInvalidCatalogDefinition, d.Key)
	}
	if !d.ComponentKey.IsValid() {
		return fmt.Errorf("%w: component key %q for monitor %q", ErrInvalidCatalogDefinition, d.ComponentKey, d.Key)
	}
	if !d.Severity.IsValid() {
		return fmt.Errorf("%w: severity %q for monitor %q", ErrInvalidCatalogDefinition, d.Severity, d.Key)
	}
	if d.ExpectedInterval <= 0 {
		return fmt.Errorf("%w: expected interval must be > 0 for monitor %q", ErrInvalidCatalogDefinition, d.Key)
	}
	if d.AutoOpenConsecutiveFailures < 0 {
		return fmt.Errorf("%w: auto_open_consecutive_failures must be >= 0 for monitor %q", ErrInvalidCatalogDefinition, d.Key)
	}
	if d.Kind == MonitorKindExternalHTTP {
		if strings.TrimSpace(d.HTTPMethod) == "" || strings.TrimSpace(d.HTTPPath) == "" {
			return fmt.Errorf("%w: external monitor %q requires method and path", ErrInvalidCatalogDefinition, d.Key)
		}
	}
	return nil
}

type HeartbeatDefinition struct {
	Key              HeartbeatKey
	DisplayName      string
	Description      string
	ComponentKey     ComponentKey
	Severity         IncidentSeverity
	ExpectedInterval time.Duration
	GraceWindow      time.Duration
	AutoOpenOnMiss   bool
}

func (d HeartbeatDefinition) Validate() error {
	if !d.Key.IsValid() {
		return fmt.Errorf("%w: heartbeat key %q", ErrInvalidCatalogDefinition, d.Key)
	}
	if strings.TrimSpace(d.DisplayName) == "" {
		return fmt.Errorf("%w: heartbeat display_name required for %q", ErrInvalidCatalogDefinition, d.Key)
	}
	if !d.ComponentKey.IsValid() {
		return fmt.Errorf("%w: component key %q for heartbeat %q", ErrInvalidCatalogDefinition, d.ComponentKey, d.Key)
	}
	if !d.Severity.IsValid() {
		return fmt.Errorf("%w: severity %q for heartbeat %q", ErrInvalidCatalogDefinition, d.Severity, d.Key)
	}
	if d.ExpectedInterval <= 0 {
		return fmt.Errorf("%w: expected interval must be > 0 for heartbeat %q", ErrInvalidCatalogDefinition, d.Key)
	}
	if d.GraceWindow <= 0 {
		return fmt.Errorf("%w: grace window must be > 0 for heartbeat %q", ErrInvalidCatalogDefinition, d.Key)
	}
	return nil
}

// Catalog defines the code-backed ops catalog surface.
type Catalog interface {
	Components() []ComponentDefinition
	Component(key ComponentKey) (ComponentDefinition, bool)

	Monitors() []MonitorDefinition
	Monitor(key MonitorKey) (MonitorDefinition, bool)

	Heartbeats() []HeartbeatDefinition
	Heartbeat(key HeartbeatKey) (HeartbeatDefinition, bool)
}
