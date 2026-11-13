package postgres

import (
	"context"
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
