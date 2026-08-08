package status

import (
	"context"
	"encoding/json"
	"time"
)

const (
	SchemaVersion      = 1
	DefaultFreshness   = 7 * time.Minute
	MaxResultKeyLength = 256
	MaxFieldLength     = 128
	MaxErrorLength     = 512
	MaxMetadataBytes   = 16 << 10

	StateOperational = "operational"
	StateDegraded    = "degraded"
	StateOutage      = "outage"
	StateUnknown     = "unknown"
)

type MonitorResult struct {
	ResultKey         string
	RunID             string
	MonitorKey        string
	Status            string
	CheckedAt         time.Time
	EventAt           time.Time
	LatencyMS         int64
	HTTPStatus        *int
	ErrorCode         string
	ErrorMessage      string
	ResponseExcerpt   string
	ReportedSource    string
	ReportedEmitterID string
	Metadata          json.RawMessage
	Details           json.RawMessage
	ReceivedAt        time.Time
}

type IngestResult struct {
	ResultKey string
	Duplicate bool
}

type CurrentResult struct {
	MonitorKey    string
	ResultKey     string
	RunID         string
	Status        string
	CheckedAt     time.Time
	LastChangedAt time.Time
	ReceivedAt    time.Time
}

type ComponentDefinition struct {
	ID          string
	Name        string
	Description string
	MonitorKeys []string
}

type Component struct {
	ID            string
	Name          string
	Description   string
	State         string
	CheckedAt     *time.Time
	LastChangedAt *time.Time
}

type PublicSnapshot struct {
	SchemaVersion int
	GeneratedAt   time.Time
	Overall       string
	Components    []Component
}

type Repository interface {
	Append(ctx context.Context, result MonitorResult) (inserted bool, err error)
	Current(ctx context.Context) ([]CurrentResult, error)
}
