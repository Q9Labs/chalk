package ops

import "time"

type ActorKind string

const (
	ActorKindUser   ActorKind = "user"
	ActorKindAgent  ActorKind = "agent"
	ActorKindSystem ActorKind = "system"
)

type Severity string

const (
	SeverityInfo     Severity = "info"
	SeverityMinor    Severity = "minor"
	SeverityMajor    Severity = "major"
	SeverityCritical Severity = "critical"
)

type IncidentStatus string

const (
	IncidentStatusInvestigating IncidentStatus = "investigating"
	IncidentStatusIdentified    IncidentStatus = "identified"
	IncidentStatusMonitoring    IncidentStatus = "monitoring"
	IncidentStatusResolved      IncidentStatus = "resolved"
)

type Visibility string

const (
	VisibilityInternal Visibility = "internal"
	VisibilityPublic   Visibility = "public"
)

type SourceKind string

const (
	SourceKindManual    SourceKind = "manual"
	SourceKindMonitor   SourceKind = "monitor"
	SourceKindHeartbeat SourceKind = "heartbeat"
	SourceKindSystem    SourceKind = "system"
)

type SignalStatus string

const (
	SignalStatusHealthy  SignalStatus = "healthy"
	SignalStatusDegraded SignalStatus = "degraded"
	SignalStatusFailed   SignalStatus = "failed"
)

type HeartbeatStatus string

const (
	HeartbeatStatusOK     HeartbeatStatus = "ok"
	HeartbeatStatusFailed HeartbeatStatus = "failed"
)

type ComponentState string

const (
	ComponentStateOperational ComponentState = "operational"
	ComponentStateDegraded    ComponentState = "degraded"
	ComponentStateOutage      ComponentState = "outage"
	ComponentStateMaintenance ComponentState = "maintenance"
)

type Component struct {
	ID          string
	Name        string
	Description string
}

type Monitor struct {
	Key                string
	Name               string
	ComponentID        string
	Kind               string
	URL                string
	ExpectedStatusCode int
	Severity           Severity
	AutoOpen           bool
}

type Heartbeat struct {
	Key         string
	Name        string
	ComponentID string
	Interval    time.Duration
	Grace       time.Duration
	Severity    Severity
	AutoOpen    bool
}

var Components = []Component{
	{ID: "api", Name: "API", Description: "Public API and backend health"},
	{ID: "web", Name: "Web App", Description: "Public website and status page"},
	{ID: "workers", Name: "Workers", Description: "Background jobs and asynchronous processing"},
}

var Monitors = []Monitor{
	{
		Key:                "api.health",
		Name:               "API Health",
		ComponentID:        "api",
		Kind:               "http",
		URL:                "https://chalk-api.q9labs.ai/health",
		ExpectedStatusCode: 200,
		Severity:           SeverityCritical,
		AutoOpen:           true,
	},
	{
		Key:                "api.debug_ping",
		Name:               "API Debug Ping",
		ComponentID:        "api",
		Kind:               "http",
		URL:                "https://chalk-api.q9labs.ai/api/v1/debug/ping",
		ExpectedStatusCode: 200,
		Severity:           SeverityMajor,
		AutoOpen:           false,
	},
	{
		Key:                "web.home",
		Name:               "Web Home",
		ComponentID:        "web",
		Kind:               "http",
		URL:                "https://chalkmeet.com/",
		ExpectedStatusCode: 200,
		Severity:           SeverityCritical,
		AutoOpen:           true,
	},
	{
		Key:                "web.status",
		Name:               "Public Status Page",
		ComponentID:        "web",
		Kind:               "http",
		URL:                "https://chalkmeet.com/status",
		ExpectedStatusCode: 200,
		Severity:           SeverityMajor,
		AutoOpen:           false,
	},
}

var Heartbeats = []Heartbeat{
	{
		Key:         "internal_retention.job",
		Name:        "Internal Retention Job",
		ComponentID: "workers",
		Interval:    6 * time.Hour,
		Grace:       90 * time.Minute,
		Severity:    SeverityMajor,
		AutoOpen:    false,
	},
	{
		Key:         "transcription.worker",
		Name:        "Transcription Worker",
		ComponentID: "workers",
		Interval:    30 * time.Second,
		Grace:       3 * time.Minute,
		Severity:    SeverityCritical,
		AutoOpen:    true,
	},
	{
		Key:         "webhook.delivery.worker",
		Name:        "Webhook Delivery Worker",
		ComponentID: "workers",
		Interval:    30 * time.Second,
		Grace:       3 * time.Minute,
		Severity:    SeverityCritical,
		AutoOpen:    true,
	},
	{
		Key:         "ops.heartbeat_evaluator",
		Name:        "Heartbeat Evaluator",
		ComponentID: "workers",
		Interval:    time.Minute,
		Grace:       3 * time.Minute,
		Severity:    SeverityCritical,
		AutoOpen:    true,
	},
}

func CanTransition(from, to IncidentStatus) bool {
	if from == to {
		return true
	}
	switch from {
	case IncidentStatusInvestigating:
		return to == IncidentStatusIdentified || to == IncidentStatusMonitoring || to == IncidentStatusResolved
	case IncidentStatusIdentified:
		return to == IncidentStatusMonitoring || to == IncidentStatusResolved
	case IncidentStatusMonitoring:
		return to == IncidentStatusIdentified || to == IncidentStatusResolved
	case IncidentStatusResolved:
		return false
	default:
		return false
	}
}

func ComponentByID(id string) (Component, bool) {
	for _, component := range Components {
		if component.ID == id {
			return component, true
		}
	}
	return Component{}, false
}

func MonitorByKey(key string) (Monitor, bool) {
	for _, monitor := range Monitors {
		if monitor.Key == key {
			return monitor, true
		}
	}
	return Monitor{}, false
}

func HeartbeatByKey(key string) (Heartbeat, bool) {
	for _, heartbeat := range Heartbeats {
		if heartbeat.Key == key {
			return heartbeat, true
		}
	}
	return Heartbeat{}, false
}
