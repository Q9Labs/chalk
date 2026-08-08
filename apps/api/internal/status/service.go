package status

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
)

var (
	ErrInvalidResult     = errors.New("invalid monitor result")
	ErrStatusUnavailable = errors.New("status store unavailable")
)

type Config struct {
	Freshness time.Duration
	Now       func() time.Time
}

type Service struct {
	repository Repository
	freshness  time.Duration
	now        func() time.Time
}

var tracer = otel.Tracer("github.com/q9labs/chalk/apps/api/internal/status")

func NewService(repository Repository, config Config) Service {
	freshness := config.Freshness
	if freshness <= 0 {
		freshness = DefaultFreshness
	}
	now := config.Now
	if now == nil {
		now = time.Now
	}
	return Service{repository: repository, freshness: freshness, now: now}
}

func (s Service) Ingest(ctx context.Context, input MonitorResult) (result IngestResult, err error) {
	ctx, span := tracer.Start(ctx, "status.monitor_result.ingest")
	defer span.End()
	defer func() {
		if err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, "status result rejected")
			span.SetAttributes(attribute.String("status.outcome", "rejected"))
			return
		}
		outcome := "accepted"
		if result.Duplicate {
			outcome = "duplicate"
		}
		span.SetAttributes(attribute.String("status.outcome", outcome))
	}()

	if s.repository == nil {
		return IngestResult{}, ErrStatusUnavailable
	}
	now := s.now().UTC()
	input = prepareResult(input)
	if err := validateResult(input, now); err != nil {
		return IngestResult{}, err
	}
	input.ReceivedAt = now
	inserted, err := s.repository.Append(ctx, input)
	if err != nil {
		return IngestResult{}, err
	}
	return IngestResult{ResultKey: input.ResultKey, Duplicate: !inserted}, nil
}

func (s Service) Snapshot(ctx context.Context) (snapshot PublicSnapshot, err error) {
	ctx, span := tracer.Start(ctx, "status.public_snapshot.get")
	defer span.End()
	defer func() {
		if err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, "status snapshot unavailable")
			return
		}
		span.SetAttributes(attribute.String("status.overall", snapshot.Overall), attribute.Int("status.components", len(snapshot.Components)))
	}()

	snapshot.GeneratedAt = s.now().UTC()
	snapshot.SchemaVersion = SchemaVersion
	snapshot.Overall = StateUnknown
	if s.repository == nil {
		return snapshot, ErrStatusUnavailable
	}
	rows, err := s.repository.Current(ctx)
	if err != nil {
		return PublicSnapshot{}, err
	}
	snapshot = buildSnapshot(rows, snapshot.GeneratedAt, s.freshness)
	return snapshot, nil
}

// PublicSnapshot is a named alias for callers that prefer the operation name.
func (s Service) PublicSnapshot(ctx context.Context) (PublicSnapshot, error) {
	return s.Snapshot(ctx)
}

func validateResult(result MonitorResult, now time.Time) error {
	if !boundedRequired(result.ResultKey, MaxResultKeyLength) ||
		!boundedRequired(result.RunID, MaxFieldLength) ||
		!boundedRequired(result.MonitorKey, MaxFieldLength) ||
		!boundedRequired(result.ReportedSource, MaxFieldLength) ||
		!boundedRequired(result.ReportedEmitterID, MaxFieldLength) {
		return ErrInvalidResult
	}
	if _, ok := knownMonitorKeys()[result.MonitorKey]; !ok {
		return ErrInvalidResult
	}
	result.Status = strings.ToLower(strings.TrimSpace(result.Status))
	if result.Status != "healthy" && result.Status != "failed" {
		return ErrInvalidResult
	}
	if result.CheckedAt.IsZero() || result.EventAt.IsZero() || result.CheckedAt.After(now.Add(5*time.Minute)) || result.EventAt.After(now.Add(5*time.Minute)) {
		return ErrInvalidResult
	}
	if result.LatencyMS < 0 || result.LatencyMS > 120_000 {
		return ErrInvalidResult
	}
	if result.HTTPStatus != nil && (*result.HTTPStatus < 100 || *result.HTTPStatus > 599) {
		return ErrInvalidResult
	}
	for _, value := range []string{result.ErrorCode, result.ErrorMessage, result.ResponseExcerpt} {
		if len(value) > MaxErrorLength {
			return ErrInvalidResult
		}
	}
	for _, value := range []json.RawMessage{result.Metadata, result.Details} {
		if len(value) > MaxMetadataBytes {
			return ErrInvalidResult
		}
		if len(value) > 0 {
			var object map[string]any
			if err := json.Unmarshal(value, &object); err != nil || object == nil {
				return ErrInvalidResult
			}
		}
	}
	return nil
}

func prepareResult(result MonitorResult) MonitorResult {
	result.ResultKey = strings.TrimSpace(result.ResultKey)
	result.RunID = strings.TrimSpace(result.RunID)
	result.MonitorKey = strings.TrimSpace(result.MonitorKey)
	result.Status = strings.ToLower(strings.TrimSpace(result.Status))
	result.ReportedSource = strings.TrimSpace(result.ReportedSource)
	result.ReportedEmitterID = strings.TrimSpace(result.ReportedEmitterID)
	result.ErrorCode = strings.TrimSpace(result.ErrorCode)
	result.ErrorMessage = strings.TrimSpace(result.ErrorMessage)
	result.ResponseExcerpt = strings.TrimSpace(result.ResponseExcerpt)
	result.CheckedAt = result.CheckedAt.UTC()
	result.EventAt = result.EventAt.UTC()
	if len(result.Metadata) == 0 {
		result.Metadata = json.RawMessage(`{}`)
	}
	if len(result.Details) == 0 {
		result.Details = json.RawMessage(`{}`)
	}
	return result
}

func boundedRequired(value string, max int) bool {
	value = strings.TrimSpace(value)
	return value != "" && len(value) <= max
}

func buildSnapshot(rows []CurrentResult, generatedAt time.Time, freshness time.Duration) PublicSnapshot {
	byMonitor := make(map[string]CurrentResult, len(rows))
	for _, row := range rows {
		byMonitor[row.MonitorKey] = row
	}
	components := make([]Component, 0, len(ComponentCatalog()))
	overall := StateOperational
	for _, definition := range ComponentCatalog() {
		component := Component{ID: definition.ID, Name: definition.Name, Description: definition.Description, State: StateOperational}
		for _, monitorKey := range definition.MonitorKeys {
			row, ok := byMonitor[monitorKey]
			if ok {
				checkedAt := row.CheckedAt
				lastChangedAt := row.LastChangedAt
				if component.CheckedAt == nil || checkedAt.After(*component.CheckedAt) {
					component.CheckedAt = &checkedAt
				}
				if component.LastChangedAt == nil || lastChangedAt.After(*component.LastChangedAt) {
					component.LastChangedAt = &lastChangedAt
				}
			}
			nextState := StateUnknown
			if ok && !row.CheckedAt.Before(generatedAt.Add(-freshness)) {
				nextState = monitorState(monitorKey, row.Status)
			}
			component.State = worseState(component.State, nextState)
		}
		overall = worseState(overall, component.State)
		components = append(components, component)
	}
	return PublicSnapshot{SchemaVersion: SchemaVersion, GeneratedAt: generatedAt, Overall: overall, Components: components}
}

func monitorState(monitorKey, resultStatus string) string {
	if resultStatus == "healthy" {
		return StateOperational
	}
	if monitorKey == "web.space" || strings.HasSuffix(monitorKey, ".health") {
		return StateOutage
	}
	return StateDegraded
}

func worseState(current, candidate string) string {
	if stateRank(candidate) > stateRank(current) {
		return candidate
	}
	return current
}

func stateRank(state string) int {
	switch state {
	case StateOutage:
		return 4
	case StateDegraded:
		return 3
	case StateUnknown:
		return 2
	case StateOperational:
		return 1
	default:
		return 0
	}
}
