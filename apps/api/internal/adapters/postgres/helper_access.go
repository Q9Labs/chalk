package postgres

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (r EpisodeLifecycleRepository) CurrentAnnotationShare(ctx context.Context, subject accessgrants.Subject, layerID utilities.ID, publication string) (bool, error) {
	var current bool
	err := r.transaction(ctx, func(_ *sqlc.Queries, tx pgx.Tx) error {
		err := tx.QueryRow(ctx, currentAnnotationShare,
			uuid(subject.TenantID), uuid(subject.SpaceID), uuid(subject.EpisodeID),
			uuid(subject.ParticipantID), subject.ParticipantGeneration, uuid(layerID), publication, subject.ConnectionID,
		).Scan(&current)
		if err != nil {
			return fmt.Errorf("check current screen annotation share: %w", err)
		}
		return nil
	})
	return current, err
}

// Read the lease, exact layer, and sole observed screen-video publication in
// one statement. Sync rechecks these witnesses when it attaches or accepts a command.
const currentAnnotationShare = `
select exists (
    select 1
    from sync_screen_annotation_layers layer
    join episodes episode on (episode.tenant_id, episode.space_id, episode.id) =
        (layer.tenant_id, layer.space_id, layer.episode_id)
    join participants sharer on (sharer.tenant_id, sharer.space_id, sharer.episode_id) =
        (layer.tenant_id, layer.space_id, layer.episode_id)
    join sync_screen_share_leases lease on (lease.tenant_id, lease.space_id, lease.episode_id) =
        (layer.tenant_id, layer.space_id, layer.episode_id)
    where (layer.tenant_id, layer.space_id, layer.episode_id) = ($1, $2, $3)
      and layer.layer_id = $6 and layer.publication_id = $7
      and layer.sharer_id = $4 and layer.sharer_generation = $5
      and episode.status = 'active'
      and sharer.id = $4 and sharer.generation = $5 and sharer.status = 'active'
      and sharer.media_connection_id = $8 and sharer.media_connection_generation = $5
      and lease.owner_participant_id = $4 and lease.owner_generation = $5
      and lease.status = 'active'
      and least(lease.renewed_until, lease.hard_expires_at) > clock_timestamp()
      and $7 = (
          select min(item->>'publication_id')
          from provider_operation_observation_heads head
          join provider_operation_observations observation using (tenant_id, episode_id, incarnation, sequence)
          cross join lateral jsonb_array_elements(observation.publications) item
          where head.tenant_id = $1 and head.episode_id = $3
            and item->>'participant_id' = $4::uuid::text
            and item->>'source' = 'screen' and item->>'enabled' = 'true'
            and not exists (
                select 1 from sync_media_pauses pause
                where (pause.tenant_id, pause.space_id, pause.episode_id) = ($1, $2, $3)
                  and pause.participant_id = $4 and pause.source = 'screen'
                  and pause.publication_id = item->>'publication_id'
            )
          having count(*) = 1
      )
)
`
