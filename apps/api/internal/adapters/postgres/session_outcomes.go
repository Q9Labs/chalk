package postgres

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type sessionOutcomeExecer interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// SessionOutcomes saves how the media node's sessions ended with the Participants they belong to.
type SessionOutcomes struct{ db sessionOutcomeExecer }

func NewSessionOutcomes(db sessionOutcomeExecer) SessionOutcomes { return SessionOutcomes{db: db} }

const recordSessionOutcomes = `insert into participant_media_sessions
    (tenant_id, space_id, episode_id, participant_id, generation, connection_id, cause, outcome, connected, ended_at, lifetime_ms, connect_ms, disconnects, outage_ms)
select p.tenant_id, p.space_id, p.episode_id, p.id, o.generation, o.connection_id, o.cause, o.outcome, o.connected, o.ended_at, o.lifetime_ms,
    case when o.connected then o.connect_ms end, o.disconnects, o.outage_ms
from unnest($3::uuid[], $4::bigint[], $5::text[], $6::text[], $7::text[], $8::boolean[], $9::timestamptz[], $10::bigint[], $11::bigint[], $12::int[], $13::bigint[])
    as o(participant_id, generation, connection_id, cause, outcome, connected, ended_at, lifetime_ms, connect_ms, disconnects, outage_ms)
join participants p on p.tenant_id = $1 and p.episode_id = $2 and p.id = o.participant_id
on conflict (tenant_id, episode_id, connection_id) do nothing`

// Record saves the outcomes of one Episode's sessions. A session already saved stays as it was, and
// an outcome of a Participant the Episode no longer holds is dropped, so a repeat is harmless.
func (s SessionOutcomes) Record(ctx context.Context, tenantID, episodeID utilities.ID, outcomes []mediaplane.SessionOutcome) error {
	var (
		participants                              []pgtype.UUID
		generations, lifetimes, connects, outages []int64
		connections, causes, results              []string
		connected                                 []bool
		ended                                     []time.Time
		disconnects                               []int32
	)
	for _, outcome := range outcomes {
		participant, err := utilities.ParseID(outcome.ParticipantRef)
		if err != nil {
			continue
		}
		participants = append(participants, uuid(participant))
		generations = append(generations, outcome.ParticipantVersion)
		connections = append(connections, outcome.ConnectionID)
		causes = append(causes, outcome.Cause)
		results = append(results, outcome.Outcome)
		connected = append(connected, outcome.Connected)
		ended = append(ended, outcome.EndedAt)
		lifetimes = append(lifetimes, outcome.LifetimeMs)
		connects = append(connects, outcome.ConnectMs)
		disconnects = append(disconnects, int32(outcome.Disconnects))
		outages = append(outages, outcome.OutageMs)
	}
	if len(participants) == 0 {
		return nil
	}
	if _, err := s.db.Exec(ctx, recordSessionOutcomes, uuid(tenantID), uuid(episodeID), participants, generations, connections, causes, results, connected, ended, lifetimes, connects, disconnects, outages); err != nil {
		return fmt.Errorf("save how the media sessions of an Episode ended: %w", err)
	}
	return nil
}
