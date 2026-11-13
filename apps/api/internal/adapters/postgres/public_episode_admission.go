package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// Public admission records only associate an authenticated arrival with the
// canonical Episode request. Sync owns admission, denial, and expiry.
func (r PublicInviteRepository) CreateAdmissionRequest(ctx context.Context, request publicinvites.AdmissionRequest, clients mediaplane.ClientProviders) (publicinvites.AdmissionRequest, error) {
	arrival, err := r.GetArrival(ctx, request.ArrivalHandle)
	if err != nil {
		return publicinvites.AdmissionRequest{}, err
	}
	create := &admissionCreate{repo: r, arrival: arrival, requestedAt: request.RequestedAt, clients: clients}
	err = r.lifecycle.transaction(ctx, func(queries *sqlc.Queries, tx pgx.Tx) error {
		create.queries, create.tx = queries, tx
		return create.run(ctx)
	})
	if err == nil {
		create.metric.Record(ctx)
	}
	return create.result, err
}

// admissionCreate is one create transaction for a public arrival.
type admissionCreate struct {
	repo        PublicInviteRepository
	queries     *sqlc.Queries
	tx          pgx.Tx
	arrival     publicinvites.Arrival
	requestedAt time.Time
	clients     mediaplane.ClientProviders
	result      publicinvites.AdmissionRequest
	metric      webhookCommitMetric
}

func (c *admissionCreate) run(ctx context.Context) error {
	arrival := c.arrival
	if c.repo.lifecycle.tenantLimits.AppliesTo(arrival.TenantID) && c.repo.lifecycle.tenantLimits.MaxLiveEpisodes > 0 {
		if _, err := c.queries.LockTenantMediaLimits(ctx, uuid(arrival.TenantID)); err != nil {
			return fmt.Errorf("lock public admission tenant limits: %w", err)
		}
	}
	invite, err := c.queries.LockSpacePublicInvite(ctx, sqlc.LockSpacePublicInviteParams{TenantID: uuid(arrival.TenantID), SpaceID: uuid(arrival.SpaceID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return publicinvites.ErrArrivalUnavailable
	}
	if err != nil {
		return fmt.Errorf("lock public admission invite: %w", err)
	}
	space, err := c.queries.LockTenantSpaceForAdmission(ctx, sqlc.LockTenantSpaceForAdmissionParams{TenantID: uuid(arrival.TenantID), ID: uuid(arrival.SpaceID)})
	if err != nil {
		return fmt.Errorf("lock public admission Space: %w", err)
	}
	if space.ArchivedAt.Valid {
		return publicinvites.ErrInviteUnavailable
	}
	// The Space lock serializes creation. Resolve a retry before ensuring a
	// live Episode: its original Episode may already have ended.
	handle := sqlc.GetSpacePublicAdmissionRequestForArrivalParams{TenantID: uuid(arrival.TenantID), SpaceID: uuid(arrival.SpaceID), ArrivalHandle: uuid(arrival.ArrivalHandle)}
	if found, err := c.replay(ctx, handle); err != nil || found {
		return err
	}
	episode, _, metric, err := c.repo.lifecycle.ensurePublicLiveEpisode(ctx, c.queries, c.tx, arrival.TenantID, arrival.SpaceID, space, c.clients)
	if err != nil {
		return err
	}
	c.metric = metric
	if episode.Status != episodes.EpisodeStatusActive {
		return episodes.ErrEpisodeNotActive
	}
	current, err := c.queries.LockSpacePublicArrival(ctx, uuid(arrival.ArrivalHandle))
	if err != nil {
		return fmt.Errorf("lock public admission arrival: %w", err)
	}
	// A previous API can commit its arrival-first INSERT while we wait on
	// this arrival. Recheck before creating an unbound canonical request.
	handle = sqlc.GetSpacePublicAdmissionRequestForArrivalParams{TenantID: current.TenantID, SpaceID: current.SpaceID, ArrivalHandle: current.ArrivalHandle}
	if found, err := c.replay(ctx, handle); err != nil || found {
		return err
	}
	valid, err := publicAdmissionProvenanceValid(space, invite, current, episode, time.Now())
	if err != nil {
		return err
	}
	if !valid {
		return publicinvites.ErrArrivalUnavailable
	}
	return c.create(ctx, episode, current)
}

// replay loads the request an earlier attempt already created for this arrival.
func (c *admissionCreate) replay(ctx context.Context, arrival sqlc.GetSpacePublicAdmissionRequestForArrivalParams) (bool, error) {
	existing, err := c.queries.GetSpacePublicAdmissionRequestForArrival(ctx, arrival)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	c.result = mapPublicAdmissionProjection(sqlc.ListPendingSpacePublicAdmissionRequestsRow(existing))
	return true, nil
}

// create files the canonical knock admission and binds the public arrival to it.
func (c *admissionCreate) create(ctx context.Context, episode sqlc.Episode, current sqlc.SpacePublicArrival) error {
	arrival := c.arrival
	config, err := episodeConfig(episode.ConfigSnapshot)
	if err != nil {
		return err
	}
	capabilities, ok := config.Roles[publicinvites.PublicRoleCollaborator]
	if !ok {
		return episodes.ErrInvalidRole
	}
	participantID, err := utilities.NewID()
	if err != nil {
		return err
	}
	input := episodes.AdmitParticipantInput{
		TenantID: arrival.TenantID, SpaceID: arrival.SpaceID, EpisodeID: utilities.IDFromBytes(episode.ID.Bytes),
		ParticipantID: participantID, Name: arrival.DisplayName, Role: publicinvites.PublicRoleCollaborator,
		Request: episodes.Request{Key: arrival.IdempotencyKey, Fingerprint: arrival.IdempotencyFingerprint},
	}
	var admission episodes.Admission
	if err := createKnockAdmission(ctx, c.queries, c.tx, input, episode, capabilities, episodes.ParticipantJoinedPayload(participantID, arrival.DisplayName, input.Role), &admission); err != nil {
		return err
	}
	row, err := c.queries.CreateSpacePublicAdmissionRequest(ctx, sqlc.CreateSpacePublicAdmissionRequestParams{
		RequestHandle: uuid(admission.AdmissionRequest.ID), ArrivalHandle: current.ArrivalHandle,
		TenantID: current.TenantID, SpaceID: current.SpaceID, DisplayName: arrival.DisplayName,
		RequestedAt: timestamptz(&c.requestedAt), ExpiresAt: timestamptz(&admission.AdmissionRequest.ExpiresAt),
	})
	if err != nil {
		return fmt.Errorf("associate public arrival with Episode admission: %w", err)
	}
	c.result = mapPublicAdmissionRequest(row)
	return nil
}

func (r PublicInviteRepository) GetAdmissionRequestForArrival(ctx context.Context, arrival publicinvites.Arrival) (publicinvites.AdmissionRequest, error) {
	row, err := r.queries.GetSpacePublicAdmissionRequestForArrival(ctx, sqlc.GetSpacePublicAdmissionRequestForArrivalParams{TenantID: uuid(arrival.TenantID), SpaceID: uuid(arrival.SpaceID), ArrivalHandle: uuid(arrival.ArrivalHandle)})
	if errors.Is(err, pgx.ErrNoRows) {
		return publicinvites.AdmissionRequest{}, publicinvites.ErrAdmissionRequestNotFound
	}
	if err != nil {
		return publicinvites.AdmissionRequest{}, fmt.Errorf("get public arrival admission: %w", err)
	}
	return r.withAdmissionBinding(ctx, mapPublicAdmissionProjection(sqlc.ListPendingSpacePublicAdmissionRequestsRow(row)))
}

func (r PublicInviteRepository) withAdmissionBinding(ctx context.Context, request publicinvites.AdmissionRequest) (publicinvites.AdmissionRequest, error) {
	binding, err := r.queries.GetPublicAdmissionBinding(ctx, sqlc.GetPublicAdmissionBindingParams{TenantID: uuid(request.TenantID), SpaceID: uuid(request.SpaceID), RequestHandle: uuid(request.RequestHandle)})
	if errors.Is(err, pgx.ErrNoRows) {
		return request, nil // A request created before canonical admission was wired.
	}
	if err != nil {
		return publicinvites.AdmissionRequest{}, fmt.Errorf("get public admission binding: %w", err)
	}
	request.Binding = &publicinvites.AdmissionBinding{EpisodeID: utilities.IDFromBytes(binding.EpisodeID.Bytes), ParticipantID: utilities.IDFromBytes(binding.ParticipantID.Bytes), ParticipantGeneration: binding.Generation}
	return request, nil
}

func (r PublicInviteRepository) DecideAdmissionRequest(ctx context.Context, input publicinvites.DecideAdmissionRequestInput) (publicinvites.AdmissionRequest, publicinvites.Arrival, error) {
	request, err := r.GetAdmissionRequest(ctx, input.TenantID, input.SpaceID, input.RequestHandle)
	if err != nil {
		return publicinvites.AdmissionRequest{}, publicinvites.Arrival{}, err
	}
	arrival, err := r.GetArrival(ctx, request.ArrivalHandle)
	if err != nil {
		return publicinvites.AdmissionRequest{}, publicinvites.Arrival{}, err
	}
	decision := &admissionDecision{input: input, arrivalHandle: arrival.ArrivalHandle}
	err = r.lifecycle.transaction(ctx, func(queries *sqlc.Queries, tx pgx.Tx) error {
		decision.queries, decision.tx = queries, tx
		return decision.run(ctx)
	})
	if err != nil {
		return publicinvites.AdmissionRequest{}, publicinvites.Arrival{}, err
	}
	if decision.legacy {
		return r.decideLegacyAdmissionRequest(ctx, input)
	}
	request, err = r.GetAdmissionRequest(ctx, input.TenantID, input.SpaceID, input.RequestHandle)
	return request, arrival, err
}

// admissionDecision is one decision transaction. legacy is set when the request has no canonical
// Episode admission, which a previous API created.
// TRIPWIRE(api-db, 2026-12-15): remove the legacy path once no pending public request lacks an
// Episode admission.
type admissionDecision struct {
	queries       *sqlc.Queries
	tx            pgx.Tx
	input         publicinvites.DecideAdmissionRequestInput
	arrivalHandle utilities.ID
	legacy        bool
}

// decisionRows are the rows a decision locks, in the order Sync locks them.
type decisionRows struct {
	invite  sqlc.SpacePublicInvite
	space   sqlc.Space
	episode sqlc.Episode
	live    sqlc.SyncAdmissionRequest
}

func (d *admissionDecision) run(ctx context.Context) error {
	input := d.input
	// Match Sync's lock order: control, Episode, admission request.
	live, err := d.queries.GetPublicEpisodeAdmission(ctx, sqlc.GetPublicEpisodeAdmissionParams{TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), RequestHandle: uuid(input.RequestHandle)})
	if errors.Is(err, pgx.ErrNoRows) {
		d.legacy = true
		return nil
	}
	if err != nil {
		return err
	}
	rows, err := d.lockRows(ctx, live)
	if err != nil {
		return err
	}
	operationName := "admit_participant"
	if input.Decision == publicinvites.DecisionDeny {
		operationName = "deny_admission"
	}
	if done, err := d.settled(ctx, rows.live, operationName); err != nil || done {
		return err
	}
	return d.record(ctx, rows, operationName)
}

func (d *admissionDecision) lockRows(ctx context.Context, live sqlc.SyncAdmissionRequest) (decisionRows, error) {
	input := d.input
	// Arrival creation holds the invite while its Space foreign key is
	// checked, so take the invite before the Space here too.
	invite, err := d.queries.LockSpacePublicInvite(ctx, sqlc.LockSpacePublicInviteParams{TenantID: live.TenantID, SpaceID: live.SpaceID})
	if err != nil {
		return decisionRows{}, err
	}
	space, err := d.queries.LockTenantSpaceForAdmission(ctx, sqlc.LockTenantSpaceForAdmissionParams{TenantID: live.TenantID, ID: live.SpaceID})
	if err != nil {
		return decisionRows{}, err
	}
	episodeID := utilities.IDFromBytes(live.EpisodeID.Bytes)
	if _, err := lockLifecycleControlRow(ctx, d.queries, input.TenantID, input.SpaceID, episodeID); err != nil {
		return decisionRows{}, err
	}
	episode, err := lockLifecycleEpisode(ctx, d.queries, input.TenantID, input.SpaceID, episodeID)
	if err != nil {
		return decisionRows{}, err
	}
	live, err = d.queries.LockPublicEpisodeAdmission(ctx, sqlc.LockPublicEpisodeAdmissionParams{TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), RequestHandle: uuid(input.RequestHandle)})
	if err != nil {
		return decisionRows{}, err
	}
	return decisionRows{invite: invite, space: space, episode: episode, live: live}, nil
}

// settled reports whether the request already carries this decision. A different decision, or a request
// that is no longer pending without one, is terminal.
func (d *admissionDecision) settled(ctx context.Context, live sqlc.SyncAdmissionRequest, operationName string) (bool, error) {
	if live.Status != "pending" {
		if (live.Status == "admitted" && d.input.Decision == publicinvites.DecisionApprove) || (live.Status == "denied" && d.input.Decision == publicinvites.DecisionDeny) {
			return true, nil
		}
		return false, publicinvites.ErrAdmissionRequestTerminal
	}
	if !live.DecisionExternalOperationID.Valid {
		return false, nil
	}
	name, err := d.queries.GetAdmissionDecisionOperationName(ctx, sqlc.GetAdmissionDecisionOperationNameParams{TenantID: live.TenantID, EpisodeID: live.EpisodeID, ExternalOperationID: live.DecisionExternalOperationID})
	if err != nil {
		return false, err
	}
	if name != operationName {
		return false, publicinvites.ErrAdmissionRequestTerminal
	}
	return true, nil
}

func (d *admissionDecision) record(ctx context.Context, rows decisionRows, operationName string) error {
	input, live := d.input, rows.live
	// Previous APIs lock the public request before the arrival when deciding.
	if _, err := d.queries.LockSpacePublicAdmissionRequest(ctx, sqlc.LockSpacePublicAdmissionRequestParams{TenantID: live.TenantID, SpaceID: live.SpaceID, RequestHandle: uuid(input.RequestHandle)}); err != nil {
		return err
	}
	currentArrival, err := d.queries.LockSpacePublicArrival(ctx, uuid(d.arrivalHandle))
	if err != nil {
		return err
	}
	valid, err := publicAdmissionProvenanceValid(rows.space, rows.invite, currentArrival, rows.episode, time.Now())
	if err != nil {
		return err
	}
	if !valid || !live.ExpiresAt.Time.After(time.Now()) {
		return publicinvites.ErrAdmissionRequestTerminal
	}
	payload, err := json.Marshal(struct {
		ID string `json:"admissionRequestId"`
	}{input.RequestHandle.String()})
	if err != nil {
		return err
	}
	key := input.RequestKey
	if key == "" {
		key = input.RequestHandle.String()
	}
	operation, err := createOrRetryAdmissionDecision(ctx, d.queries, d.tx, tenantExternalOperationInput{
		TenantID: input.TenantID, SpaceID: input.SpaceID, EpisodeID: utilities.IDFromBytes(live.EpisodeID.Bytes), OperationName: operationName,
		Request: episodes.Request{Key: key, Fingerprint: sha256.Sum256(payload)}, Payload: payload,
		JourneyName: "participant.public_admission_decided",
	})
	if err != nil {
		return err
	}
	reserved, err := d.queries.ReserveEpisodeAdmissionDecision(ctx, sqlc.ReserveEpisodeAdmissionDecisionParams{TenantID: live.TenantID, SpaceID: live.SpaceID, EpisodeID: live.EpisodeID, AdmissionRequestID: live.AdmissionRequestID, ExternalOperationID: operation.ExternalOperationID})
	if err != nil {
		return err
	}
	if reserved != 1 {
		return publicinvites.ErrAdmissionRequestTerminal
	}
	return d.queries.RecordPublicAdmissionDecision(ctx, sqlc.RecordPublicAdmissionDecisionParams{
		TenantID: live.TenantID, SpaceID: live.SpaceID, RequestHandle: uuid(input.RequestHandle),
		DecidedBy: uuid(input.ActorID), DecisionRequestKey: optionalText(key),
	})
}
