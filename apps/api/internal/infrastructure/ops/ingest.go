package ops

import (
	"context"
	"errors"
	"fmt"
	"time"

	domainops "github.com/Q9Labs/chalk/internal/domain/ops"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/jackc/pgx/v5"
)

func (s *Service) IngestMonitorResult(ctx context.Context, input MonitorIngestInput) (db.OpsMonitorResult, *db.OpsIncident, error) {
	monitor, ok := domainops.MonitorByKey(input.MonitorKey)
	if !ok {
		return db.OpsMonitorResult{}, nil, fmt.Errorf("unknown monitor key %q", input.MonitorKey)
	}
	checkedAt := nowIfZero(input.CheckedAt)
	if input.ResultKey == "" {
		input.ResultKey = fmt.Sprintf("%s:%d", input.MonitorKey, checkedAt.Unix())
	}

	result, err := s.queries.CreateOpsMonitorResult(ctx, db.CreateOpsMonitorResultParams{
		MonitorKey:        monitor.Key,
		MonitorKind:       monitor.Kind,
		Status:            string(input.Status),
		HttpStatus:        input.HTTPStatus,
		LatencyMs:         input.LatencyMs,
		CheckedAt:         checkedAt,
		RunID:             optionalString(input.RunID),
		ResultKey:         input.ResultKey,
		ErrorCode:         optionalString(input.ErrorCode),
		ErrorMessage:      optionalString(input.ErrorMessage),
		Details:           metadataJSON(input.Details),
		ReportedSource:    optionalString(input.ReportedSource),
		ReportedEmitterID: optionalString(input.ReportedEmitterID),
	})
	if err != nil {
		return db.OpsMonitorResult{}, nil, err
	}

	active, err := s.findActiveIncident(ctx, domainops.SourceKindMonitor, monitor.Key)
	if err != nil {
		return result, nil, err
	}

	if input.Status == domainops.SignalStatusHealthy {
		if active != nil {
			resolved, err := s.resolveSignalIncident(ctx, *active, checkedAt, "monitor recovered")
			return result, &resolved, err
		}
		return result, nil, nil
	}

	if active != nil {
		if _, err := s.queries.TouchOpsIncidentObservation(ctx, db.TouchOpsIncidentObservationParams{
			ID:         active.ID,
			LastSeenAt: checkedAt,
		}); err != nil {
			return result, nil, err
		}
		_, err := s.queries.AppendOpsIncidentEvent(ctx, db.AppendOpsIncidentEventParams{
			IncidentID: active.ID,
			EventType:  "signal.observed",
			Visibility: string(domainops.VisibilityInternal),
			ActorKind:  string(domainops.ActorKindSystem),
			ActorID:    "ops-monitor",
			Message:    firstNonEmpty(input.ErrorMessage, fmt.Sprintf("%s reported %s", monitor.Name, input.Status)),
			Metadata: metadataJSON(map[string]any{
				"monitor_key": monitor.Key,
				"result_key":  input.ResultKey,
				"status":      input.Status,
			}),
			IdempotencyKey: optionalString("result:" + input.ResultKey),
			EventAt:        checkedAt,
		})
		return result, active, err
	}

	if !monitor.AutoOpen || input.Status != domainops.SignalStatusFailed {
		return result, nil, nil
	}

	incident, err := s.DeclareIncident(ctx, DeclareIncidentInput{
		Title:        fmt.Sprintf("%s failing", monitor.Name),
		Summary:      firstNonEmpty(input.ErrorMessage, fmt.Sprintf("%s is failing from external uptime checks", monitor.Name)),
		Severity:     monitor.Severity,
		Status:       domainops.IncidentStatusInvestigating,
		Visibility:   domainops.VisibilityInternal,
		SourceKind:   domainops.SourceKindMonitor,
		SourceKey:    monitor.Key,
		ComponentIDs: []string{monitor.ComponentID},
		DedupeKey:    "monitor:" + monitor.Key,
		Metadata: map[string]any{
			"monitor_key": monitor.Key,
			"result_key":  input.ResultKey,
			"url":         monitor.URL,
		},
		OccurredAt:   checkedAt,
		Actor:        Actor{Kind: domainops.ActorKindSystem, ID: "ops-monitor"},
		EventMessage: firstNonEmpty(input.ErrorMessage, fmt.Sprintf("%s failed", monitor.Name)),
	})
	if err != nil {
		return result, nil, err
	}

	return result, &incident, nil
}

func (s *Service) IngestHeartbeatEvent(ctx context.Context, input HeartbeatIngestInput) (db.OpsHeartbeatEvent, *db.OpsIncident, error) {
	heartbeat, ok := domainops.HeartbeatByKey(input.HeartbeatKey)
	if !ok {
		return db.OpsHeartbeatEvent{}, nil, fmt.Errorf("unknown heartbeat key %q", input.HeartbeatKey)
	}
	eventAt := nowIfZero(input.EventAt)
	if input.EventKey == "" {
		input.EventKey = fmt.Sprintf("%s:%d", heartbeat.Key, eventAt.Unix())
	}

	event, err := s.queries.CreateOpsHeartbeatEvent(ctx, db.CreateOpsHeartbeatEventParams{
		HeartbeatKey:      heartbeat.Key,
		Status:            string(input.Status),
		EventAt:           eventAt,
		EventKey:          input.EventKey,
		ErrorMessage:      optionalString(input.ErrorMessage),
		Details:           metadataJSON(input.Details),
		ReportedSource:    optionalString(input.ReportedSource),
		ReportedEmitterID: optionalString(input.ReportedEmitterID),
	})
	if err != nil {
		return db.OpsHeartbeatEvent{}, nil, err
	}

	active, err := s.findActiveIncident(ctx, domainops.SourceKindHeartbeat, heartbeat.Key)
	if err != nil {
		return event, nil, err
	}

	if input.Status == domainops.HeartbeatStatusOK {
		if active != nil {
			resolved, err := s.resolveSignalIncident(ctx, *active, eventAt, "heartbeat restored")
			return event, &resolved, err
		}
		return event, nil, nil
	}

	if active != nil {
		if _, err := s.queries.TouchOpsIncidentObservation(ctx, db.TouchOpsIncidentObservationParams{
			ID:         active.ID,
			LastSeenAt: eventAt,
		}); err != nil {
			return event, nil, err
		}
		return event, active, nil
	}

	if !heartbeat.AutoOpen {
		return event, nil, nil
	}

	incident, err := s.DeclareIncident(ctx, DeclareIncidentInput{
		Title:        fmt.Sprintf("%s heartbeat missing", heartbeat.Name),
		Summary:      firstNonEmpty(input.ErrorMessage, fmt.Sprintf("%s reported failure", heartbeat.Name)),
		Severity:     heartbeat.Severity,
		Status:       domainops.IncidentStatusInvestigating,
		Visibility:   domainops.VisibilityInternal,
		SourceKind:   domainops.SourceKindHeartbeat,
		SourceKey:    heartbeat.Key,
		ComponentIDs: []string{heartbeat.ComponentID},
		DedupeKey:    "heartbeat:" + heartbeat.Key,
		Metadata: map[string]any{
			"heartbeat_key": heartbeat.Key,
			"event_key":     input.EventKey,
		},
		OccurredAt:   eventAt,
		Actor:        Actor{Kind: domainops.ActorKindSystem, ID: "ops-heartbeat"},
		EventMessage: firstNonEmpty(input.ErrorMessage, fmt.Sprintf("%s heartbeat failed", heartbeat.Name)),
	})
	if err != nil {
		return event, nil, err
	}

	return event, &incident, nil
}

func (s *Service) EvaluateHeartbeats(ctx context.Context) error {
	now := time.Now().UTC()

	for _, heartbeat := range domainops.Heartbeats {
		latest, err := s.queries.GetLatestOpsHeartbeatEvent(ctx, heartbeat.Key)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				if heartbeat.AutoOpen {
					_, _, declareErr := s.IngestHeartbeatEvent(ctx, HeartbeatIngestInput{
						HeartbeatKey:  heartbeat.Key,
						Status:        domainops.HeartbeatStatusFailed,
						EventAt:       now,
						EventKey:      fmt.Sprintf("%s:miss:%d", heartbeat.Key, now.Unix()),
						ErrorMessage:  "heartbeat never observed",
						ReportedSource: "ops-heartbeat-evaluator",
					})
					if declareErr != nil {
						return declareErr
					}
				}
				continue
			}
			return err
		}

		if now.Sub(latest.EventAt) <= heartbeat.Interval+heartbeat.Grace {
			continue
		}

		active, err := s.findActiveIncident(ctx, domainops.SourceKindHeartbeat, heartbeat.Key)
		if err != nil {
			return err
		}
		if active != nil {
			if _, err := s.queries.TouchOpsIncidentObservation(ctx, db.TouchOpsIncidentObservationParams{
				ID:         active.ID,
				LastSeenAt: now,
			}); err != nil {
				return err
			}
			continue
		}
		if heartbeat.AutoOpen {
			if _, _, err := s.IngestHeartbeatEvent(ctx, HeartbeatIngestInput{
				HeartbeatKey:  heartbeat.Key,
				Status:        domainops.HeartbeatStatusFailed,
				EventAt:       now,
				EventKey:      fmt.Sprintf("%s:miss:%d", heartbeat.Key, now.Unix()),
				ErrorMessage:  fmt.Sprintf("%s missed its grace window", heartbeat.Name),
				ReportedSource: "ops-heartbeat-evaluator",
			}); err != nil {
				return err
			}
		}
	}

	return s.evaluateMonitorPipeline(ctx, now)
}

func (s *Service) RecordInternalHeartbeat(ctx context.Context, heartbeatKey string, details map[string]any) error {
	_, _, err := s.IngestHeartbeatEvent(ctx, HeartbeatIngestInput{
		HeartbeatKey:      heartbeatKey,
		Status:            domainops.HeartbeatStatusOK,
		EventAt:           time.Now().UTC(),
		EventKey:          fmt.Sprintf("%s:%d", heartbeatKey, time.Now().UTC().UnixNano()),
		Details:           details,
		ReportedSource:    "api-process",
		ReportedEmitterID: "api",
	})
	return err
}

func (s *Service) resolveSignalIncident(ctx context.Context, incident db.OpsIncident, resolvedAt time.Time, message string) (db.OpsIncident, error) {
	updated, err := s.queries.UpdateOpsIncidentState(ctx, db.UpdateOpsIncidentStateParams{
		ID:            incident.ID,
		Status:        string(domainops.IncidentStatusResolved),
		Summary:       nil,
		Visibility:    nil,
		PublicMessage: nil,
		PublicTitle:   nil,
		LastSeenAt:    timestamptz(resolvedAt),
		ResolvedAt:    timestamptz(resolvedAt),
		PublishedAt:   nullTimestamptz(),
		Metadata:      nil,
	})
	if err != nil {
		return db.OpsIncident{}, err
	}
	if _, err := s.queries.AppendOpsIncidentEvent(ctx, db.AppendOpsIncidentEventParams{
		IncidentID: updated.ID,
		EventType:  "signal.recovered",
		Visibility: string(domainops.VisibilityInternal),
		ActorKind:  string(domainops.ActorKindSystem),
		ActorID:    "ops-evaluator",
		Message:    message,
		Metadata:   metadataJSON(nil),
		EventAt:    resolvedAt,
	}); err != nil {
		return db.OpsIncident{}, err
	}
	s.enqueueIncidentNotifications(ctx, updated, "resolved", message)
	return updated, nil
}

func (s *Service) evaluateMonitorPipeline(ctx context.Context, now time.Time) error {
	latestIngestAt, err := s.queries.GetLatestOpsMonitorIngestAt(ctx)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}

	active, err := s.findActiveIncident(ctx, domainops.SourceKindSystem, "ops.monitor_pipeline")
	if err != nil {
		return err
	}

	if errors.Is(err, pgx.ErrNoRows) || latestIngestAt.IsZero() || now.Sub(latestIngestAt) > 3*time.Minute {
		if active != nil {
			_, err := s.queries.TouchOpsIncidentObservation(ctx, db.TouchOpsIncidentObservationParams{
				ID:         active.ID,
				LastSeenAt: now,
			})
			return err
		}
		_, err = s.DeclareIncident(ctx, DeclareIncidentInput{
			Title:        "Monitor ingest pipeline dark",
			Summary:      "No monitor ingest has been recorded within the last three minutes.",
			Severity:     domainops.SeverityCritical,
			Status:       domainops.IncidentStatusInvestigating,
			Visibility:   domainops.VisibilityInternal,
			SourceKind:   domainops.SourceKindSystem,
			SourceKey:    "ops.monitor_pipeline",
			ComponentIDs: []string{"workers"},
			DedupeKey:    "system:ops.monitor_pipeline",
			OccurredAt:   now,
			Actor:        Actor{Kind: domainops.ActorKindSystem, ID: "ops-heartbeat-evaluator"},
			EventMessage: "Monitor ingest pipeline appears dark",
		})
		return err
	}

	if active != nil {
		_, err := s.resolveSignalIncident(ctx, *active, now, "monitor ingest pipeline recovered")
		return err
	}
	return nil
}
