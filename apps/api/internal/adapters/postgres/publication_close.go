package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
)

// ClosePublication reads and updates the snapshot under the observation head
// lock. Provider calls finish before this short transaction begins.
func (r ProviderOperationRepository) ClosePublication(ctx context.Context, input mediapublications.CloseInput) (bool, error) {
	if r.transactor == nil {
		return false, errors.New("provider operation repository has no transaction executor")
	}
	changed := false
	err := r.transaction(ctx, func(queries providerOperationQuerier) error {
		identity := providerObservationIdentityParams{TenantID: uuid(input.TenantID), EpisodeID: uuid(input.EpisodeID)}
		if err := queries.EnsureProviderObservationHead(ctx, identity); err != nil {
			return fmt.Errorf("ensure provider observation head: %w", err)
		}
		head, err := queries.LockProviderObservationHead(ctx, identity)
		if err != nil {
			return fmt.Errorf("lock provider observation head: %w", err)
		}
		var latest *provideroperations.Observation
		row, err := queries.GetProviderObservation(ctx, getProviderObservationParams{
			TenantID: identity.TenantID, EpisodeID: identity.EpisodeID, Incarnation: head.Incarnation, Sequence: head.Sequence,
		})
		if err == nil {
			observation, err := mapProviderObservation(row)
			if err != nil {
				return err
			}
			latest = &observation
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("read provider observation: %w", err)
		}
		next, err := mediapublications.CloseObservation(latest, input)
		if err != nil || next == nil {
			return err
		}
		canonical, fingerprint, payload, err := provideroperations.CanonicalizeObservation(*next)
		if err != nil {
			return err
		}
		if _, err := queries.UpdateProviderObservationHead(ctx, updateProviderObservationHeadParams{
			TenantID: identity.TenantID, EpisodeID: identity.EpisodeID, Incarnation: canonical.Incarnation, Sequence: canonical.Sequence, ObservationFingerprint: fingerprint[:],
		}); err != nil {
			return fmt.Errorf("advance provider observation head: %w", err)
		}
		if _, err := queries.InsertProviderObservation(ctx, insertProviderObservationParams{
			TenantID: identity.TenantID, EpisodeID: identity.EpisodeID, Incarnation: canonical.Incarnation, Sequence: canonical.Sequence, Publications: []byte(payload), ObservationFingerprint: fingerprint[:],
		}); err != nil {
			return fmt.Errorf("insert provider observation: %w", err)
		}
		changed = true
		return nil
	})
	return changed && err == nil, err
}
