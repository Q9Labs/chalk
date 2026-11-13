package postgres

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (r ProviderOperationRepository) AppendPublicationObservation(ctx context.Context, input provideroperations.ObservationInput, publisher mediapublications.PublicationParticipant) (provideroperations.Observation, error) {
	return r.appendObservation(ctx, input, &publisher)
}

func (r ProviderOperationRepository) AppendObservation(ctx context.Context, input provideroperations.ObservationInput) (provideroperations.Observation, error) {
	return r.appendObservation(ctx, input, nil)
}

func (r ProviderOperationRepository) appendObservation(ctx context.Context, input provideroperations.ObservationInput, publisher *mediapublications.PublicationParticipant) (provideroperations.Observation, error) {
	canonical, fingerprint, payload, err := provideroperations.CanonicalizeObservation(input)
	if err != nil {
		return provideroperations.Observation{}, err
	}
	if r.transactor == nil {
		return provideroperations.Observation{}, errors.New("provider operation repository has no transaction executor")
	}
	var result provideroperations.Observation
	err = r.transaction(ctx, func(queries providerOperationQuerier) error {
		if publisher != nil {
			if err := requirePublisher(ctx, queries, canonical, *publisher); err != nil {
				return err
			}
		}
		params := providerObservationIdentityParams{TenantID: uuid(canonical.TenantID), EpisodeID: uuid(canonical.EpisodeID)}
		if err := queries.EnsureProviderObservationHead(ctx, params); err != nil {
			return fmt.Errorf("ensure provider observation head: %w", err)
		}
		head, err := queries.LockProviderObservationHead(ctx, params)
		if err != nil {
			return fmt.Errorf("lock provider observation head: %w", err)
		}
		if observationCursorBefore(canonical.Cursor(), provideroperationsCursor(head)) {
			return provideroperations.ErrObservationStale
		}
		insert := insertProviderObservationParams{
			TenantID: uuid(canonical.TenantID), EpisodeID: uuid(canonical.EpisodeID), Incarnation: canonical.Incarnation, Sequence: canonical.Sequence, Publications: []byte(payload), ObservationFingerprint: fingerprint[:],
		}
		if sameObservationCursor(canonical.Cursor(), provideroperationsCursor(head)) {
			result, err = replayObservation(ctx, queries, insert)
			return err
		}
		if _, err := queries.UpdateProviderObservationHead(ctx, updateProviderObservationHeadParams{
			TenantID: uuid(canonical.TenantID), EpisodeID: uuid(canonical.EpisodeID), Incarnation: canonical.Incarnation, Sequence: canonical.Sequence, ObservationFingerprint: fingerprint[:],
		}); err != nil {
			return fmt.Errorf("advance provider observation head: %w", err)
		}
		row, err := queries.InsertProviderObservation(ctx, insert)
		if err != nil {
			return fmt.Errorf("insert provider observation: %w", err)
		}
		result, err = mapProviderObservation(row)
		return err
	})
	if err != nil {
		return provideroperations.Observation{}, err
	}
	return result, nil
}

// requirePublisher confirms the publishing participant is still the one the observation names.
func requirePublisher(ctx context.Context, queries providerOperationQuerier, canonical provideroperations.ObservationInput, publisher mediapublications.PublicationParticipant) error {
	participant, err := queries.LockPublicationParticipant(ctx, publicationParticipantIdentityParams{TenantID: uuid(canonical.TenantID), EpisodeID: uuid(canonical.EpisodeID), ParticipantID: uuid(publisher.ID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return mediapublications.ErrInvalidPublication
	}
	if err != nil {
		return fmt.Errorf("lock publishing participant: %w", err)
	}
	if participant.Generation != publisher.Generation || (participant.ConnectionID != "" && participant.ConnectionID != publisher.ConnectionID) {
		return mediapublications.ErrInvalidPublication
	}
	return nil
}

// replayObservation answers an observation at the head's cursor: it returns the stored row when the
// fingerprints match and records the observation when the head was advanced without one.
func replayObservation(ctx context.Context, queries providerOperationQuerier, insert insertProviderObservationParams) (provideroperations.Observation, error) {
	existing, err := queries.GetProviderObservation(ctx, getProviderObservationParams{
		TenantID: insert.TenantID, EpisodeID: insert.EpisodeID, Incarnation: insert.Incarnation, Sequence: insert.Sequence,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		row, insertErr := queries.InsertProviderObservation(ctx, insert)
		if insertErr != nil {
			return provideroperations.Observation{}, fmt.Errorf("insert provider observation replay: %w", insertErr)
		}
		return mapProviderObservation(row)
	}
	if err != nil {
		return provideroperations.Observation{}, fmt.Errorf("get provider observation replay: %w", err)
	}
	if !bytes.Equal(existing.ObservationFingerprint, insert.ObservationFingerprint) {
		return provideroperations.Observation{}, provideroperations.ErrObservationConflict
	}
	return mapProviderObservation(existing)
}

func (r ProviderOperationRepository) ListObservations(ctx context.Context, tenantID, episodeID utilities.ID, after *provideroperations.Cursor, limit int) (provideroperations.ObservationPage, error) {
	if tenantID.IsZero() {
		return provideroperations.ObservationPage{}, provideroperations.ErrInvalidTenantID
	}
	if episodeID.IsZero() {
		return provideroperations.ObservationPage{}, provideroperations.ErrInvalidEpisodeID
	}
	if after != nil && (after.Incarnation < 0 || after.Sequence < 0) {
		return provideroperations.ObservationPage{}, provideroperations.ErrInvalidObservationCursor
	}
	if limit <= 0 {
		limit = 100
	}
	if limit > 100 {
		limit = 100
	}
	params := listProviderObservationsParams{TenantID: uuid(tenantID), EpisodeID: uuid(episodeID), PageLimit: int32(limit + 1)}
	if after != nil {
		params.AfterIncarnation = pgtype.Int8{Int64: after.Incarnation, Valid: true}
		params.AfterSequence = pgtype.Int8{Int64: after.Sequence, Valid: true}
	}
	rows, err := r.queries.ListProviderObservations(ctx, params)
	if err != nil {
		return provideroperations.ObservationPage{}, fmt.Errorf("list provider observations: %w", err)
	}
	hasMore := len(rows) > limit
	if hasMore {
		rows = rows[:limit]
	}
	page := provideroperations.ObservationPage{Observations: make([]provideroperations.Observation, 0, len(rows))}
	for _, row := range rows {
		observation, err := mapProviderObservation(row)
		if err != nil {
			return provideroperations.ObservationPage{}, err
		}
		page.Observations = append(page.Observations, observation)
	}
	if hasMore {
		last := page.Observations[len(page.Observations)-1]
		page.Next = &provideroperations.Cursor{Incarnation: last.Incarnation, Sequence: last.Sequence}
	}
	return page, nil
}

func mapProviderObservation(row providerOperationObservationRow) (provideroperations.Observation, error) {
	var fingerprint [32]byte
	copy(fingerprint[:], row.ObservationFingerprint)
	var publications []struct {
		ParticipantID string  `json:"participant_id"`
		Source        string  `json:"source"`
		Enabled       bool    `json:"enabled"`
		PublicationID *string `json:"publication_id"`
	}
	if err := json.Unmarshal(row.Publications, &publications); err != nil {
		return provideroperations.Observation{}, fmt.Errorf("decode provider observation: %w", err)
	}
	result := provideroperations.Observation{TenantID: utilities.IDFromBytes(row.TenantID.Bytes), EpisodeID: utilities.IDFromBytes(row.EpisodeID.Bytes), Incarnation: row.Incarnation, Sequence: row.Sequence, Fingerprint: fingerprint, CreatedAt: timestamp(row.CreatedAt), Publications: make([]provideroperations.Publication, 0, len(publications))}
	for _, publication := range publications {
		id, err := utilities.ParseID(publication.ParticipantID)
		if err != nil {
			return provideroperations.Observation{}, fmt.Errorf("decode provider observation participant id: %w", err)
		}
		publicationID := ""
		if publication.PublicationID != nil {
			publicationID = *publication.PublicationID
		}
		result.Publications = append(result.Publications, provideroperations.Publication{ParticipantID: id, Source: publication.Source, Enabled: publication.Enabled, PublicationID: publicationID})
	}
	return result, nil
}

func provideroperationsCursor(row providerOperationObservationHeadRow) provideroperations.Cursor {
	return provideroperations.Cursor{Incarnation: row.Incarnation, Sequence: row.Sequence}
}

func observationCursorBefore(left, right provideroperations.Cursor) bool {
	return left.Incarnation < right.Incarnation || (left.Incarnation == right.Incarnation && left.Sequence < right.Sequence)
}

func sameObservationCursor(left, right provideroperations.Cursor) bool {
	return left.Incarnation == right.Incarnation && left.Sequence == right.Sequence
}

func (r ProviderOperationRepository) LatestObservation(ctx context.Context, tenantID, episodeID utilities.ID) (provideroperations.Observation, error) {
	if tenantID.IsZero() {
		return provideroperations.Observation{}, provideroperations.ErrInvalidTenantID
	}
	if episodeID.IsZero() {
		return provideroperations.Observation{}, provideroperations.ErrInvalidEpisodeID
	}
	row, err := r.queries.LatestProviderObservation(ctx, providerObservationIdentityParams{TenantID: uuid(tenantID), EpisodeID: uuid(episodeID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return provideroperations.Observation{}, provideroperations.ErrObservationNotFound
	}
	if err != nil {
		return provideroperations.Observation{}, fmt.Errorf("read latest provider observation: %w", err)
	}
	return mapProviderObservation(row)
}
