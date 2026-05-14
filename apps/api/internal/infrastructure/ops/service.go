package ops

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/Q9Labs/chalk/internal/config"
	domainops "github.com/Q9Labs/chalk/internal/domain/ops"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	redisinfra "github.com/Q9Labs/chalk/internal/infrastructure/redis"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const (
	publicHistoryBucketCount    = 60
	publicHistoryBucketInterval = time.Minute
)

type Service struct {
	pool       *postgres.Pool
	queries    *db.Queries
	redis      *redisinfra.Client
	config     *config.Config
	logger     *slog.Logger
	httpClient *TwilioClient
	ai         *AIClient
}

func NewService(pool *postgres.Pool, queries *db.Queries, redis *redisinfra.Client, cfg *config.Config, logger *slog.Logger) *Service {
	if logger == nil {
		logger = slog.Default()
	}
	svc := &Service{
		pool:    pool,
		queries: queries,
		redis:   redis,
		config:  cfg,
		logger:  logger.With("component", "ops_service"),
	}
	svc.httpClient = NewTwilioClient(cfg, logger)
	svc.ai = NewAIClient(cfg, logger)
	return svc
}

func (s *Service) DeclareIncident(ctx context.Context, input DeclareIncidentInput) (db.OpsIncident, error) {
	actor := actorOrSystem(input.Actor)
	occurredAt := nowIfZero(input.OccurredAt)
	if input.Status == "" {
		input.Status = domainops.IncidentStatusInvestigating
	}
	if input.Visibility == "" {
		input.Visibility = domainops.VisibilityInternal
	}
	if input.IncidentCode == "" {
		input.IncidentCode = incidentCode(occurredAt)
	}
	if len(input.ComponentIDs) == 0 {
		input.ComponentIDs = []string{"api"}
	}
	if strings.TrimSpace(input.Title) == "" {
		return db.OpsIncident{}, errors.New("title is required")
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return db.OpsIncident{}, err
	}
	defer tx.Rollback(ctx)

	qtx := s.queries.WithTx(tx)
	row, err := qtx.CreateOpsIncident(ctx, db.CreateOpsIncidentParams{
		IncidentCode:   input.IncidentCode,
		Title:          strings.TrimSpace(input.Title),
		Summary:        optionalString(input.Summary),
		Severity:       string(input.Severity),
		Status:         string(input.Status),
		Visibility:     string(input.Visibility),
		SourceKind:     string(input.SourceKind),
		SourceKey:      optionalString(input.SourceKey),
		ComponentIds:   input.ComponentIDs,
		DedupeKey:      optionalString(input.DedupeKey),
		IdempotencyKey: optionalString(input.IdempotencyKey),
		PublicMessage:  optionalString(input.PublicMessage),
		PublicTitle:    optionalString(input.PublicTitle),
		Metadata:       metadataJSON(input.Metadata),
		FirstSeenAt:    occurredAt,
		LastSeenAt:     occurredAt,
		PublishedAt:    nullTimestamptz(),
		ResolvedAt:     nullTimestamptz(),
		CreatedBy:      actor.ID,
	})
	if err != nil {
		return db.OpsIncident{}, err
	}

	eventMessage := strings.TrimSpace(input.EventMessage)
	if eventMessage == "" {
		eventMessage = fmt.Sprintf("%s incident declared", titleCaseSeverity(input.Severity))
	}

	if _, err := qtx.AppendOpsIncidentEvent(ctx, db.AppendOpsIncidentEventParams{
		IncidentID:     row.ID,
		EventType:      "declared",
		Visibility:     string(domainops.VisibilityInternal),
		ActorKind:      string(actor.Kind),
		ActorID:        actor.ID,
		Message:        eventMessage,
		Metadata:       metadataJSON(input.Metadata),
		IdempotencyKey: optionalString(input.IdempotencyKey),
		EventAt:        occurredAt,
	}); err != nil {
		return db.OpsIncident{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return db.OpsIncident{}, err
	}

	s.enqueueIncidentNotifications(ctx, row, "declared", eventMessage)
	return row, nil
}

func (s *Service) AddEvent(ctx context.Context, input AddEventInput) (IncidentDetails, error) {
	incident, err := s.queries.GetOpsIncidentByCode(ctx, input.IncidentCode)
	if err != nil {
		return IncidentDetails{}, err
	}
	actor := actorOrSystem(input.Actor)
	eventAt := nowIfZero(input.EventAt)

	if input.TransitionTo != "" && !domainops.CanTransition(domainops.IncidentStatus(incident.Status), input.TransitionTo) {
		return IncidentDetails{}, fmt.Errorf("invalid transition from %s to %s", incident.Status, input.TransitionTo)
	}

	if _, err := s.queries.AppendOpsIncidentEvent(ctx, db.AppendOpsIncidentEventParams{
		IncidentID:     incident.ID,
		EventType:      strings.TrimSpace(input.EventType),
		Visibility:     string(input.Visibility),
		ActorKind:      string(actor.Kind),
		ActorID:        actor.ID,
		Message:        input.Message,
		Metadata:       metadataJSON(input.Metadata),
		IdempotencyKey: optionalString(input.IdempotencyKey),
		EventAt:        eventAt,
	}); err != nil {
		return IncidentDetails{}, err
	}

	if input.TransitionTo != "" || input.PublicMessage != "" || input.PublicTitle != "" || input.UpdatedSummary != "" {
		params := db.UpdateOpsIncidentStateParams{
			ID:            incident.ID,
			Status:        incident.Status,
			Summary:       optionalString(input.UpdatedSummary),
			Visibility:    nil,
			PublicMessage: optionalString(input.PublicMessage),
			PublicTitle:   optionalString(input.PublicTitle),
			LastSeenAt:    nullTimestamptz(),
			ResolvedAt:    nullTimestamptz(),
			PublishedAt:   nullTimestamptz(),
			Metadata:      nil,
		}
		if input.TransitionTo != "" {
			params.Status = string(input.TransitionTo)
			if input.TransitionTo == domainops.IncidentStatusResolved {
				params.ResolvedAt = timestamptz(eventAt)
			}
		}
		if _, err := s.queries.UpdateOpsIncidentState(ctx, params); err != nil {
			return IncidentDetails{}, err
		}
	}

	return s.GetIncident(ctx, input.IncidentCode)
}

func (s *Service) PublishIncident(ctx context.Context, input PublishIncidentInput) (IncidentDetails, error) {
	incident, err := s.queries.GetOpsIncidentByCode(ctx, input.IncidentCode)
	if err != nil {
		return IncidentDetails{}, err
	}
	actor := actorOrSystem(input.Actor)
	eventAt := nowIfZero(input.EventAt)
	params := db.UpdateOpsIncidentStateParams{
		ID:            incident.ID,
		Status:        incident.Status,
		Summary:       nil,
		Visibility:    optionalString(string(domainops.VisibilityPublic)),
		PublicMessage: optionalString(firstNonEmpty(input.PublicMessage, deref(incident.PublicMessage), input.Message)),
		PublicTitle:   optionalString(firstNonEmpty(input.PublicTitle, deref(incident.PublicTitle), incident.Title)),
		LastSeenAt:    nullTimestamptz(),
		ResolvedAt:    nullTimestamptz(),
		PublishedAt:   timestamptz(eventAt),
		Metadata:      nil,
	}
	updated, err := s.queries.UpdateOpsIncidentState(ctx, params)
	if err != nil {
		return IncidentDetails{}, err
	}
	eventMessage := firstNonEmpty(input.Message, "Incident published to the public status page")
	if _, err := s.queries.AppendOpsIncidentEvent(ctx, db.AppendOpsIncidentEventParams{
		IncidentID: updated.ID,
		EventType:  "published",
		Visibility: string(domainops.VisibilityPublic),
		ActorKind:  string(actor.Kind),
		ActorID:    actor.ID,
		Message:    eventMessage,
		Metadata:   metadataJSON(nil),
		EventAt:    eventAt,
	}); err != nil {
		return IncidentDetails{}, err
	}
	s.enqueueIncidentNotifications(ctx, updated, "published", eventMessage)
	return s.GetIncident(ctx, input.IncidentCode)
}

func (s *Service) ResolveIncident(ctx context.Context, input ResolveIncidentInput) (IncidentDetails, error) {
	incident, err := s.queries.GetOpsIncidentByCode(ctx, input.IncidentCode)
	if err != nil {
		return IncidentDetails{}, err
	}
	eventAt := nowIfZero(input.EventAt)
	actor := actorOrSystem(input.Actor)
	updated, err := s.queries.UpdateOpsIncidentState(ctx, db.UpdateOpsIncidentStateParams{
		ID:            incident.ID,
		Status:        string(domainops.IncidentStatusResolved),
		Summary:       optionalString(input.Summary),
		Visibility:    nil,
		PublicMessage: nil,
		PublicTitle:   nil,
		LastSeenAt:    timestamptz(eventAt),
		ResolvedAt:    timestamptz(eventAt),
		PublishedAt:   nullTimestamptz(),
		Metadata:      nil,
	})
	if err != nil {
		return IncidentDetails{}, err
	}

	message := firstNonEmpty(input.Message, "Incident resolved")
	if _, err := s.queries.AppendOpsIncidentEvent(ctx, db.AppendOpsIncidentEventParams{
		IncidentID: updated.ID,
		EventType:  "resolved",
		Visibility: string(domainops.VisibilityInternal),
		ActorKind:  string(actor.Kind),
		ActorID:    actor.ID,
		Message:    message,
		Metadata:   metadataJSON(nil),
		EventAt:    eventAt,
	}); err != nil {
		return IncidentDetails{}, err
	}

	s.enqueueIncidentNotifications(ctx, updated, "resolved", message)
	return s.GetIncident(ctx, input.IncidentCode)
}

func (s *Service) GetIncident(ctx context.Context, incidentCode string) (IncidentDetails, error) {
	incident, err := s.queries.GetOpsIncidentByCode(ctx, incidentCode)
	if err != nil {
		return IncidentDetails{}, err
	}
	events, err := s.queries.ListOpsIncidentEvents(ctx, incident.ID)
	if err != nil {
		return IncidentDetails{}, err
	}
	return IncidentDetails{Incident: incident, Events: events}, nil
}

func (s *Service) ListIncidents(ctx context.Context, limit, offset int32) ([]db.OpsIncident, error) {
	return s.queries.ListOpsIncidents(ctx, db.ListOpsIncidentsParams{Limit: limit, Offset: offset})
}

func (s *Service) ScheduleMaintenance(ctx context.Context, title, summary string, components []string, startsAt, endsAt time.Time, actor Actor, publicMessage string) (db.OpsMaintenanceWindow, error) {
	actor = actorOrSystem(actor)
	return s.queries.CreateOpsMaintenanceWindow(ctx, db.CreateOpsMaintenanceWindowParams{
		Title:         strings.TrimSpace(title),
		Summary:       optionalString(summary),
		ComponentIds:  components,
		Visibility:    string(domainops.VisibilityPublic),
		Status:        "scheduled",
		StartsAt:      startsAt.UTC(),
		EndsAt:        endsAt.UTC(),
		CreatedBy:     actor.ID,
		PublicMessage: optionalString(publicMessage),
		Metadata:      metadataJSON(nil),
	})
}

func (s *Service) CancelMaintenance(ctx context.Context, id uuid.UUID) (db.OpsMaintenanceWindow, error) {
	return s.queries.CancelOpsMaintenanceWindow(ctx, id)
}

func (s *Service) ListMaintenance(ctx context.Context) ([]db.OpsMaintenanceWindow, error) {
	return s.queries.ListOpsMaintenanceWindows(ctx)
}

func (s *Service) Overview(ctx context.Context) (Overview, error) {
	incidents, err := s.queries.ListActiveOpsIncidents(ctx)
	if err != nil {
		return Overview{}, err
	}
	maintenance, err := s.queries.ListOpsMaintenanceWindows(ctx)
	if err != nil {
		return Overview{}, err
	}
	monitors, err := s.queries.ListLatestOpsMonitorResults(ctx)
	if err != nil {
		return Overview{}, err
	}
	heartbeats, err := s.queries.ListLatestOpsHeartbeatEvents(ctx)
	if err != nil {
		return Overview{}, err
	}
	return Overview{
		Incidents:   incidents,
		Maintenance: maintenance,
		Signals: SignalSnapshot{
			Monitors:   monitors,
			Heartbeats: heartbeats,
		},
	}, nil
}

func (s *Service) PublicStatus(ctx context.Context) (PublicStatusSummary, error) {
	active, err := s.queries.ListActivePublicOpsIncidents(ctx)
	if err != nil {
		return PublicStatusSummary{}, err
	}
	recent, err := s.queries.ListRecentResolvedPublicOpsIncidents(ctx, 10)
	if err != nil {
		return PublicStatusSummary{}, err
	}
	maintenance, err := s.queries.ListActivePublicOpsMaintenanceWindows(ctx)
	if err != nil {
		return PublicStatusSummary{}, err
	}

	historyByComponent, uptimePctByComponent, err := s.buildPublicComponentHistory(ctx, time.Now().UTC())
	if err != nil {
		return PublicStatusSummary{}, err
	}

	componentStates := make(map[string]PublicComponentStatus, len(domainops.Components))
	for _, component := range domainops.Components {
		componentStates[component.ID] = PublicComponentStatus{
			ID:              component.ID,
			Name:            component.Name,
			Description:     component.Description,
			State:           domainops.ComponentStateOperational,
			RecentUptimePct: uptimePctByComponent[component.ID],
			History:         historyByComponent[component.ID],
		}
	}

	for _, window := range maintenance {
		for _, componentID := range window.ComponentIds {
			component, ok := componentStates[componentID]
			if !ok {
				continue
			}
			component.State = domainops.ComponentStateMaintenance
			component.Message = firstNonEmpty(deref(window.PublicMessage), deref(window.Summary), window.Title)
			componentStates[componentID] = component
		}
	}

	for _, incident := range active {
		for _, componentID := range incident.ComponentIds {
			component, ok := componentStates[componentID]
			if !ok {
				continue
			}
			nextState := domainops.ComponentStateDegraded
			if incident.Severity == string(domainops.SeverityCritical) {
				nextState = domainops.ComponentStateOutage
			}
			if component.State != domainops.ComponentStateOutage || nextState == domainops.ComponentStateOutage {
				component.State = nextState
				component.Message = firstNonEmpty(deref(incident.PublicMessage), deref(incident.Summary), incident.Title)
			}
			componentStates[componentID] = component
		}
	}

	components := make([]PublicComponentStatus, 0, len(componentStates))
	overall := domainops.ComponentStateOperational
	for _, component := range domainops.Components {
		item := componentStates[component.ID]
		components = append(components, item)
		switch item.State {
		case domainops.ComponentStateOutage:
			overall = domainops.ComponentStateOutage
		case domainops.ComponentStateDegraded:
			if overall != domainops.ComponentStateOutage {
				overall = domainops.ComponentStateDegraded
			}
		case domainops.ComponentStateMaintenance:
			if overall == domainops.ComponentStateOperational {
				overall = domainops.ComponentStateMaintenance
			}
		}
	}

	return PublicStatusSummary{
		GeneratedAt:        time.Now().UTC(),
		Overall:            overall,
		Components:         components,
		ActiveIncidents:    active,
		RecentIncidents:    recent,
		Maintenance:        maintenance,
		HistoryWindowLabel: fmt.Sprintf("Last %d minutes", publicHistoryBucketCount),
	}, nil
}

func (s *Service) PublicIncident(ctx context.Context, code string) (IncidentDetails, error) {
	incident, err := s.queries.GetOpsIncidentByCode(ctx, code)
	if err != nil {
		return IncidentDetails{}, err
	}
	events, err := s.queries.ListPublicOpsIncidentEvents(ctx, incident.ID)
	if err != nil {
		return IncidentDetails{}, err
	}
	return IncidentDetails{Incident: incident, Events: events}, nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" {
			return value
		}
	}
	return ""
}

type publicMonitorHistoryRow struct {
	MonitorKey string
	Status     string
	CheckedAt  time.Time
}

type publicHeartbeatHistoryRow struct {
	HeartbeatKey string
	Status       string
	EventAt      time.Time
}

type bucketSignalAccumulator struct {
	state   domainops.ComponentState
	at      time.Time
	hasData bool
}

func (s *Service) buildPublicComponentHistory(ctx context.Context, now time.Time) (map[string][]PublicHistoryBucket, map[string]*float64, error) {
	start := now.UTC().Truncate(publicHistoryBucketInterval).Add(-time.Duration(publicHistoryBucketCount-1) * publicHistoryBucketInterval)
	end := start.Add(time.Duration(publicHistoryBucketCount) * publicHistoryBucketInterval)

	monitorRows, err := s.pool.Query(ctx, `
SELECT monitor_key, status, checked_at
FROM ops_monitor_results
WHERE checked_at >= $1
  AND checked_at < $2
ORDER BY checked_at ASC
`, start, end)
	if err != nil {
		return nil, nil, err
	}
	defer monitorRows.Close()

	heartbeatRows, err := s.pool.Query(ctx, `
SELECT heartbeat_key, status, event_at
FROM ops_heartbeat_events
WHERE event_at >= $1
  AND event_at < $2
ORDER BY event_at ASC
`, start, end)
	if err != nil {
		return nil, nil, err
	}
	defer heartbeatRows.Close()

	historyByComponent := make(map[string][]PublicHistoryBucket, len(domainops.Components))
	accumulators := make(map[string]map[int]map[string]bucketSignalAccumulator, len(domainops.Components))
	dataBuckets := make(map[string]int, len(domainops.Components))
	healthyBuckets := make(map[string]int, len(domainops.Components))

	for _, component := range domainops.Components {
		history := make([]PublicHistoryBucket, publicHistoryBucketCount)
		for i := range history {
			history[i] = PublicHistoryBucket{
				State:     domainops.ComponentStateOperational,
				Timestamp: start.Add(time.Duration(i) * publicHistoryBucketInterval),
				HasData:   false,
			}
		}
		historyByComponent[component.ID] = history
		accumulators[component.ID] = make(map[int]map[string]bucketSignalAccumulator, publicHistoryBucketCount)
	}

	for monitorRows.Next() {
		var row publicMonitorHistoryRow
		if err := monitorRows.Scan(&row.MonitorKey, &row.Status, &row.CheckedAt); err != nil {
			return nil, nil, err
		}
		monitor, ok := domainops.MonitorByKey(row.MonitorKey)
		if !ok {
			continue
		}
		index := int(row.CheckedAt.UTC().Sub(start) / publicHistoryBucketInterval)
		if index < 0 || index >= publicHistoryBucketCount {
			continue
		}
		upsertBucketSignal(accumulators[monitor.ComponentID], index, row.MonitorKey, row.CheckedAt.UTC(), componentStateFromMonitorStatus(row.Status))
	}
	if err := monitorRows.Err(); err != nil {
		return nil, nil, err
	}

	for heartbeatRows.Next() {
		var row publicHeartbeatHistoryRow
		if err := heartbeatRows.Scan(&row.HeartbeatKey, &row.Status, &row.EventAt); err != nil {
			return nil, nil, err
		}
		heartbeat, ok := domainops.HeartbeatByKey(row.HeartbeatKey)
		if !ok {
			continue
		}
		index := int(row.EventAt.UTC().Sub(start) / publicHistoryBucketInterval)
		if index < 0 || index >= publicHistoryBucketCount {
			continue
		}
		upsertBucketSignal(accumulators[heartbeat.ComponentID], index, row.HeartbeatKey, row.EventAt.UTC(), componentStateFromHeartbeatStatus(row.Status))
	}
	if err := heartbeatRows.Err(); err != nil {
		return nil, nil, err
	}

	uptimePctByComponent := make(map[string]*float64, len(domainops.Components))
	for _, component := range domainops.Components {
		history := historyByComponent[component.ID]
		componentBuckets := accumulators[component.ID]
		for i := 0; i < publicHistoryBucketCount; i++ {
			signals := componentBuckets[i]
			if len(signals) == 0 {
				continue
			}
			worst := domainops.ComponentStateOperational
			for _, signal := range signals {
				if componentStateRank(signal.state) > componentStateRank(worst) {
					worst = signal.state
				}
			}
			history[i].HasData = true
			history[i].State = worst
			dataBuckets[component.ID]++
			if worst == domainops.ComponentStateOperational {
				healthyBuckets[component.ID]++
			}
		}
		historyByComponent[component.ID] = history
		if dataBuckets[component.ID] == 0 {
			uptimePctByComponent[component.ID] = nil
			continue
		}
		pct := (float64(healthyBuckets[component.ID]) / float64(dataBuckets[component.ID])) * 100
		uptimePctByComponent[component.ID] = &pct
	}

	return historyByComponent, uptimePctByComponent, nil
}

func upsertBucketSignal(componentBuckets map[int]map[string]bucketSignalAccumulator, index int, signalKey string, at time.Time, state domainops.ComponentState) {
	if componentBuckets[index] == nil {
		componentBuckets[index] = make(map[string]bucketSignalAccumulator)
	}
	existing, ok := componentBuckets[index][signalKey]
	if !ok || at.After(existing.at) {
		componentBuckets[index][signalKey] = bucketSignalAccumulator{
			state:   state,
			at:      at,
			hasData: true,
		}
	}
}

func componentStateFromMonitorStatus(status string) domainops.ComponentState {
	switch status {
	case string(domainops.SignalStatusHealthy):
		return domainops.ComponentStateOperational
	case string(domainops.SignalStatusDegraded):
		return domainops.ComponentStateDegraded
	case string(domainops.SignalStatusFailed):
		return domainops.ComponentStateOutage
	default:
		return domainops.ComponentStateOperational
	}
}

func componentStateFromHeartbeatStatus(status string) domainops.ComponentState {
	switch status {
	case string(domainops.HeartbeatStatusOK):
		return domainops.ComponentStateOperational
	case string(domainops.HeartbeatStatusFailed):
		return domainops.ComponentStateOutage
	default:
		return domainops.ComponentStateOperational
	}
}

func componentStateRank(state domainops.ComponentState) int {
	switch state {
	case domainops.ComponentStateOutage:
		return 3
	case domainops.ComponentStateDegraded:
		return 2
	case domainops.ComponentStateMaintenance:
		return 1
	default:
		return 0
	}
}

func deref(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func (s *Service) findActiveIncident(ctx context.Context, sourceKind domainops.SourceKind, sourceKey string) (*db.OpsIncident, error) {
	if strings.TrimSpace(sourceKey) == "" {
		return nil, nil
	}
	incident, err := s.queries.GetActiveOpsIncidentBySource(ctx, db.GetActiveOpsIncidentBySourceParams{
		SourceKind: string(sourceKind),
		SourceKey:  optionalString(sourceKey),
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return &incident, nil
}
