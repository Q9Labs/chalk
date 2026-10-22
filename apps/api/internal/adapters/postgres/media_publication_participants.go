package postgres

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const publicationParticipantEligible = `(participants.status = 'active' or
  (participants.status = 'joining' and exists (
    select 1 from participant_join_seats seat
    where seat.participant_id = participants.id
      and seat.generation = participants.generation
      and seat.state = 'pending' and seat.expires_at > now()
  )))`

func (r ProviderOperationRepository) ListPublicationParticipants(ctx context.Context, tenantID, episodeID utilities.ID) ([]mediapublications.PublicationParticipant, error) {
	return r.queries.ListPublicationParticipants(ctx, providerObservationIdentityParams{TenantID: uuid(tenantID), EpisodeID: uuid(episodeID)})
}

func (q *providerOperationQueries) ListPublicationParticipants(ctx context.Context, arg providerObservationIdentityParams) ([]mediapublications.PublicationParticipant, error) {
	const query = `select participants.id, participants.generation,
coalesce(case when participants.media_connection_generation = participants.generation then participants.media_connection_id end, '')
from participants
join episodes on episodes.tenant_id = participants.tenant_id and episodes.id = participants.episode_id
where participants.tenant_id = $1 and participants.episode_id = $2
  and ` + publicationParticipantEligible + ` and episodes.status = 'active'`
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

type publicationParticipantIdentityParams struct{ TenantID, EpisodeID, ParticipantID pgtype.UUID }

func (q *providerOperationQueries) LockPublicationParticipant(ctx context.Context, arg publicationParticipantIdentityParams) (mediapublications.PublicationParticipant, error) {
	// Observation inserts check both parent foreign keys. Take those locks before
	// the participant, matching the lifecycle's Episode -> participant order.
	var parent pgtype.UUID
	if err := q.db.QueryRow(ctx, `select id from tenants where id = $1 for key share`, arg.TenantID).Scan(&parent); err != nil {
		return mediapublications.PublicationParticipant{}, err
	}
	if err := q.db.QueryRow(ctx, `select id from episodes where tenant_id = $1 and id = $2 and status = 'active' for key share`, arg.TenantID, arg.EpisodeID).Scan(&parent); err != nil {
		return mediapublications.PublicationParticipant{}, err
	}
	const query = `select participants.id, participants.generation,
coalesce(case when participants.media_connection_generation = participants.generation then participants.media_connection_id end, '')
from participants
join episodes on episodes.tenant_id = participants.tenant_id and episodes.id = participants.episode_id
where participants.tenant_id = $1 and participants.episode_id = $2 and participants.id = $3
 and ` + publicationParticipantEligible + ` and episodes.status = 'active'
for update of participants`
	var id pgtype.UUID
	var participant mediapublications.PublicationParticipant
	if err := q.db.QueryRow(ctx, query, arg.TenantID, arg.EpisodeID, arg.ParticipantID).Scan(&id, &participant.Generation, &participant.ConnectionID); err != nil {
		return mediapublications.PublicationParticipant{}, err
	}
	participant.ID = utilities.IDFromBytes(id.Bytes)
	return participant, nil
}
