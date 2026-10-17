package postgres

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (r ProviderOperationRepository) ListPublicationParticipants(ctx context.Context, tenantID, episodeID utilities.ID) ([]mediapublications.PublicationParticipant, error) {
	return r.queries.ListPublicationParticipants(ctx, providerObservationIdentityParams{TenantID: uuid(tenantID), EpisodeID: uuid(episodeID)})
}

func (q *providerOperationQueries) ListPublicationParticipants(ctx context.Context, arg providerObservationIdentityParams) ([]mediapublications.PublicationParticipant, error) {
	const query = `select participants.id, participants.generation,
coalesce(case when participants.media_connection_generation = participants.generation then participants.media_connection_id end, '')
from participants
join episodes on episodes.tenant_id = participants.tenant_id and episodes.id = participants.episode_id
where participants.tenant_id = $1 and participants.episode_id = $2
  and participants.status = 'active' and episodes.status = 'active'`
	rows, err := q.db.Query(ctx, query, arg.TenantID, arg.EpisodeID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	participants := make([]mediapublications.PublicationParticipant, 0)
	for rows.Next() {
		var id pgtype.UUID
		var participant mediapublications.PublicationParticipant
		if err := rows.Scan(&id, &participant.Generation, &participant.ConnectionID); err != nil {
			return nil, err
		}
		participant.ID = utilities.IDFromBytes(id.Bytes)
		participants = append(participants, participant)
	}
	return participants, rows.Err()
}
