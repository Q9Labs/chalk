package ops

import "errors"

var (
	ErrInvalidComponentKey          = errors.New("invalid component key")
	ErrInvalidMonitorKey            = errors.New("invalid monitor key")
	ErrInvalidHeartbeatKey          = errors.New("invalid heartbeat key")
	ErrInvalidComponentStatus       = errors.New("invalid component status")
	ErrInvalidIncidentSeverity      = errors.New("invalid incident severity")
	ErrInvalidIncidentState         = errors.New("invalid incident state")
	ErrInvalidIncidentTransition    = errors.New("invalid incident state transition")
	ErrInvalidIncidentVisibility    = errors.New("invalid incident visibility")
	ErrInvalidMonitorResultStatus   = errors.New("invalid monitor result status")
	ErrInvalidHeartbeatEventStatus  = errors.New("invalid heartbeat event status")
	ErrInvalidCatalogDefinition     = errors.New("invalid catalog definition")
	ErrInvalidIdempotencyKey        = errors.New("invalid idempotency key")
	ErrInvalidMonitorResultKey      = errors.New("invalid monitor result key")
	ErrInvalidHeartbeatEventKey     = errors.New("invalid heartbeat event key")
	ErrInvalidAutoDedupeKey         = errors.New("invalid auto dedupe key")
	ErrInvalidAutoOpenDedupeRequest = errors.New("invalid auto-open dedupe request")
)
