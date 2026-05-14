package ops

import (
	"fmt"
	"strings"
)

type ComponentKey string

const (
	ComponentKeyAPI         ComponentKey = "api"
	ComponentKeyWebApp      ComponentKey = "web_app"
	ComponentKeyRealtime    ComponentKey = "realtime"
	ComponentKeyPostMeeting ComponentKey = "post_meeting"
)

func (k ComponentKey) String() string { return string(k) }

func (k ComponentKey) IsValid() bool { return isCatalogKey(string(k)) }

func ParseComponentKey(raw string) (ComponentKey, error) {
	key := ComponentKey(strings.TrimSpace(raw))
	if !key.IsValid() {
		return "", fmt.Errorf("%w: %q", ErrInvalidComponentKey, raw)
	}
	return key, nil
}

type MonitorKey string

const (
	MonitorKeyAPIHealth          MonitorKey = "api.health"
	MonitorKeyAPIDebugPing       MonitorKey = "api.debug_ping"
	MonitorKeyWebHome            MonitorKey = "web.home"
	MonitorKeyWebStatus          MonitorKey = "web.status"
	MonitorKeyOpsMonitorPipeline MonitorKey = "ops.monitor_pipeline"
	MonitorKeyOpsEvaluator       MonitorKey = "ops.evaluator"
)

func (k MonitorKey) String() string { return string(k) }

func (k MonitorKey) IsValid() bool { return isCatalogKey(string(k)) }

func ParseMonitorKey(raw string) (MonitorKey, error) {
	key := MonitorKey(strings.TrimSpace(raw))
	if !key.IsValid() {
		return "", fmt.Errorf("%w: %q", ErrInvalidMonitorKey, raw)
	}
	return key, nil
}

type HeartbeatKey string

const (
	HeartbeatKeyInternalRetentionJob          HeartbeatKey = "internal_retention.job"
	HeartbeatKeyWebhookDeliveryWorker         HeartbeatKey = "webhook.delivery.worker"
	HeartbeatKeyPostMeetingProcessor          HeartbeatKey = "post_meeting.processor"
	HeartbeatKeyTranscriptionCallbackConsumer HeartbeatKey = "transcription.cloudflare.callback_consumer"
	HeartbeatKeyOpsEvaluator                  HeartbeatKey = "ops.evaluator"
)

func (k HeartbeatKey) String() string { return string(k) }

func (k HeartbeatKey) IsValid() bool { return isCatalogKey(string(k)) }

func ParseHeartbeatKey(raw string) (HeartbeatKey, error) {
	key := HeartbeatKey(strings.TrimSpace(raw))
	if !key.IsValid() {
		return "", fmt.Errorf("%w: %q", ErrInvalidHeartbeatKey, raw)
	}
	return key, nil
}

type ComponentStatus string

const (
	ComponentStatusOperational ComponentStatus = "operational"
	ComponentStatusDegraded    ComponentStatus = "degraded"
	ComponentStatusMajorOutage ComponentStatus = "major_outage"
	ComponentStatusMaintenance ComponentStatus = "maintenance"
)

func (s ComponentStatus) IsValid() bool {
	switch s {
	case ComponentStatusOperational, ComponentStatusDegraded, ComponentStatusMajorOutage, ComponentStatusMaintenance:
		return true
	default:
		return false
	}
}

type IncidentSeverity string

const (
	IncidentSeverityMinor    IncidentSeverity = "minor"
	IncidentSeverityMajor    IncidentSeverity = "major"
	IncidentSeverityCritical IncidentSeverity = "critical"
)

func (s IncidentSeverity) IsValid() bool {
	switch s {
	case IncidentSeverityMinor, IncidentSeverityMajor, IncidentSeverityCritical:
		return true
	default:
		return false
	}
}

func (s IncidentSeverity) Rank() int {
	switch s {
	case IncidentSeverityCritical:
		return 3
	case IncidentSeverityMajor:
		return 2
	case IncidentSeverityMinor:
		return 1
	default:
		return 0
	}
}

type IncidentState string

const (
	IncidentStateOpen       IncidentState = "open"
	IncidentStateMonitoring IncidentState = "monitoring"
	IncidentStateResolved   IncidentState = "resolved"
)

func (s IncidentState) IsValid() bool {
	switch s {
	case IncidentStateOpen, IncidentStateMonitoring, IncidentStateResolved:
		return true
	default:
		return false
	}
}

func (s IncidentState) IsActive() bool {
	return s == IncidentStateOpen || s == IncidentStateMonitoring
}

type IncidentVisibility string

const (
	IncidentVisibilityInternal IncidentVisibility = "internal"
	IncidentVisibilityPublic   IncidentVisibility = "public"
)

func (v IncidentVisibility) IsValid() bool {
	switch v {
	case IncidentVisibilityInternal, IncidentVisibilityPublic:
		return true
	default:
		return false
	}
}

type MonitorResultStatus string

const (
	MonitorResultStatusOK     MonitorResultStatus = "ok"
	MonitorResultStatusFailed MonitorResultStatus = "failed"
)

func (s MonitorResultStatus) IsValid() bool {
	switch s {
	case MonitorResultStatusOK, MonitorResultStatusFailed:
		return true
	default:
		return false
	}
}

type HeartbeatEventStatus string

const (
	HeartbeatEventStatusOK        HeartbeatEventStatus = "ok"
	HeartbeatEventStatusMissed    HeartbeatEventStatus = "missed"
	HeartbeatEventStatusRecovered HeartbeatEventStatus = "recovered"
)

func (s HeartbeatEventStatus) IsValid() bool {
	switch s {
	case HeartbeatEventStatusOK, HeartbeatEventStatusMissed, HeartbeatEventStatusRecovered:
		return true
	default:
		return false
	}
}

type MaintenanceState string

const (
	MaintenanceStateScheduled MaintenanceState = "scheduled"
	MaintenanceStateActive    MaintenanceState = "active"
	MaintenanceStateCompleted MaintenanceState = "completed"
	MaintenanceStateCancelled MaintenanceState = "cancelled"
)

func (s MaintenanceState) IsValid() bool {
	switch s {
	case MaintenanceStateScheduled, MaintenanceStateActive, MaintenanceStateCompleted, MaintenanceStateCancelled:
		return true
	default:
		return false
	}
}

func isCatalogKey(raw string) bool {
	if raw == "" {
		return false
	}
	for _, r := range raw {
		isAlphaNum := r >= 'a' && r <= 'z' || r >= '0' && r <= '9'
		if isAlphaNum {
			continue
		}
		switch r {
		case '.', '_', '-', ':':
			continue
		default:
			return false
		}
	}
	return true
}
