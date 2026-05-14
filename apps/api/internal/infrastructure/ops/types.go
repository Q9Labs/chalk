package ops

import (
	"time"

	domainops "github.com/Q9Labs/chalk/internal/domain/ops"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
)

type Actor struct {
	Kind domainops.ActorKind
	ID   string
}

type DeclareIncidentInput struct {
	IncidentCode   string
	Title          string
	Summary        string
	Severity       domainops.Severity
	Status         domainops.IncidentStatus
	Visibility     domainops.Visibility
	SourceKind     domainops.SourceKind
	SourceKey      string
	ComponentIDs   []string
	DedupeKey      string
	IdempotencyKey string
	PublicMessage  string
	PublicTitle    string
	Metadata       map[string]any
	OccurredAt     time.Time
	Actor          Actor
	EventMessage   string
}

type AddEventInput struct {
	IncidentCode   string
	EventType      string
	Visibility     domainops.Visibility
	Message        string
	Metadata       map[string]any
	IdempotencyKey string
	EventAt        time.Time
	Actor          Actor
	TransitionTo   domainops.IncidentStatus
	PublicMessage  string
	PublicTitle    string
	UpdatedSummary string
}

type PublishIncidentInput struct {
	IncidentCode  string
	Message       string
	PublicMessage string
	PublicTitle   string
	Actor         Actor
	EventAt       time.Time
}

type ResolveIncidentInput struct {
	IncidentCode string
	Message      string
	Summary      string
	Actor        Actor
	EventAt      time.Time
}

type MonitorIngestInput struct {
	MonitorKey        string
	Status            domainops.SignalStatus
	CheckedAt         time.Time
	RunID             string
	ResultKey         string
	HTTPStatus        *int32
	LatencyMs         *int32
	ErrorCode         string
	ErrorMessage      string
	Details           map[string]any
	ReportedSource    string
	ReportedEmitterID string
}

type HeartbeatIngestInput struct {
	HeartbeatKey      string
	Status            domainops.HeartbeatStatus
	EventAt           time.Time
	EventKey          string
	ErrorMessage      string
	Details           map[string]any
	ReportedSource    string
	ReportedEmitterID string
}

type IncidentDetails struct {
	Incident db.OpsIncident        `json:"incident"`
	Events   []db.OpsIncidentEvent `json:"events"`
}

type SignalSnapshot struct {
	Monitors   []db.OpsMonitorResult  `json:"monitors"`
	Heartbeats []db.OpsHeartbeatEvent `json:"heartbeats"`
}

type Overview struct {
	Incidents   []db.OpsIncident          `json:"incidents"`
	Maintenance []db.OpsMaintenanceWindow `json:"maintenance"`
	Signals     SignalSnapshot            `json:"signals"`
}

type PublicComponentStatus struct {
	ID              string                   `json:"id"`
	Name            string                   `json:"name"`
	Description     string                   `json:"description"`
	State           domainops.ComponentState `json:"state"`
	Message         string                   `json:"message,omitempty"`
	RecentUptimePct *float64                 `json:"recent_uptime_pct,omitempty"`
	History         []PublicHistoryBucket    `json:"history,omitempty"`
}

type PublicHistoryBucket struct {
	State     domainops.ComponentState `json:"state"`
	Timestamp time.Time                `json:"timestamp"`
	HasData   bool                     `json:"has_data"`
}

type PublicStatusSummary struct {
	GeneratedAt        time.Time                 `json:"generated_at"`
	Overall            domainops.ComponentState  `json:"overall"`
	Components         []PublicComponentStatus   `json:"components"`
	ActiveIncidents    []db.OpsIncident          `json:"active_incidents"`
	RecentIncidents    []db.OpsIncident          `json:"recent_incidents"`
	Maintenance        []db.OpsMaintenanceWindow `json:"maintenance"`
	HistoryWindowLabel string                    `json:"history_window_label,omitempty"`
}

type IncidentDrafts struct {
	InternalSummary string `json:"internal_summary"`
	PublicUpdate    string `json:"public_update"`
	ResolutionNote  string `json:"resolution_note"`
}
