package postgres

import (
	"context"
	"errors"
	"fmt"
	"net/netip"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/sfufleet"
)

type sfuWindowDirectoryQueries interface {
	ListRoutableSFUWindowNodes(context.Context, string) ([]sqlc.ListRoutableSFUWindowNodesRow, error)
}

func ListSFUWindowRoutes(ctx context.Context, queries sfuWindowDirectoryQueries, application string) ([]sfufleet.Route, error) {
	rows, err := queries.ListRoutableSFUWindowNodes(ctx, application)
	if err != nil {
		return nil, err
	}
	routes := make([]sfufleet.Route, 0, len(rows))
	for _, row := range rows {
		if row.ControlAddress == nil {
			return nil, errors.New("routable SFU window node has no control address")
		}
		routes = append(routes, sfufleet.Route{
			ID: row.ID, Address: *row.ControlAddress, Accepting: row.Phase == string(sfufleet.Serving),
		})
	}
	return routes, nil
}

type SFUWindowStore struct {
	queries *sqlc.Queries
}

func NewSFUWindowStore(db sqlc.DBTX) SFUWindowStore {
	return SFUWindowStore{queries: sqlc.New(db)}
}

func (s SFUWindowStore) Load(ctx context.Context, application string, lookahead time.Duration, slotsPerNode int) (sfufleet.Snapshot, error) {
	now := time.Now().UTC()
	fingerprint, err := mediaplane.AdapterFingerprint(mediaplane.ProviderChalkSFU, application)
	if err != nil {
		return sfufleet.Snapshot{}, err
	}
	live, err := s.queries.ListSFULiveDemand(ctx, fingerprint)
	if err != nil {
		return sfufleet.Snapshot{}, err
	}
	planned, err := s.queries.ListUpcomingScheduledEpisodes(ctx, sqlc.ListUpcomingScheduledEpisodesParams{
		WindowStart: timestamptzValue(now),
		WindowEnd:   timestamptzValue(now.Add(lookahead)),
	})
	if err != nil {
		return sfufleet.Snapshot{}, err
	}
	rows, err := s.queries.ListSFUWindowNodes(ctx, application)
	if err != nil {
		return sfufleet.Snapshot{}, err
	}
	nodeSeconds, err := s.queries.ReadSFUWindowNodeSeconds(ctx, sqlc.ReadSFUWindowNodeSecondsParams{
		ApplicationID: application, ObservedAt: timestamptz(&now), Since: timestamptzValue(now.Add(-31 * 24 * time.Hour)),
	})
	if err != nil {
		return sfufleet.Snapshot{}, err
	}

	type spaceKey struct{ tenant, space [16]byte }
	liveSpaces := make(map[spaceKey]sqlc.ListSFULiveDemandRow, len(live))
	demand := sfufleet.Demand{Bookings: make([]sfufleet.Booking, 0, len(planned))}
	for _, episode := range live {
		liveSpaces[spaceKey{episode.TenantID.Bytes, episode.SpaceID.Bytes}] = episode
		demand.LiveSlots += sfufleet.ClassSlots(int(episode.Participants), slotsPerNode)
	}
	for i := len(planned) - 1; i >= 0; i-- {
		booking := planned[i]
		start, end := booking.StartsAt.Time, booking.ExpectedEndsAt.Time
		key := spaceKey{booking.TenantID.Bytes, booking.SpaceID.Bytes}
		covered := 0
		if episode, ok := liveSpaces[key]; ok && episode.StartedAt.Valid && !start.After(now) &&
			!episode.StartedAt.Time.Before(start.Add(-lookahead)) && episode.StartedAt.Time.Before(end) {
			covered = sfufleet.ClassSlots(int(episode.Participants), slotsPerNode)
			delete(liveSpaces, key)
		}
		demand.Bookings = append(demand.Bookings, sfufleet.Booking{
			StartsAt: start, EndsAt: end, Participants: int(booking.ParticipantCount), CoveredSlots: covered,
		})
	}

	result := sfufleet.Snapshot{ObservedAt: now, Demand: demand, NodeTime: time.Duration(nodeSeconds) * time.Second}
	for _, row := range rows {
		var address netip.Addr
		if row.ControlAddress != nil {
			address = *row.ControlAddress
		}
		result.Nodes = append(result.Nodes, sfufleet.Node{
			ID: row.ID, ProviderID: row.ProviderID.Int64, Address: address, Phase: sfufleet.Phase(row.Phase),
			CreatedAt: row.CreatedAt.Time, EmptySince: row.EmptySince.Time, EmptyIncarnation: row.EmptyIncarnation.String,
		})
	}
	return result, nil
}

func (s SFUWindowStore) Reserve(ctx context.Context, application, id string, maxNodes int) error {
	count, err := s.queries.ReserveSFUWindowNode(ctx, sqlc.ReserveSFUWindowNodeParams{
		ID: id, ApplicationID: application, MaxNodes: int64(maxNodes),
	})
	return checkSFUWindowWrite(count, err)
}

func (s SFUWindowStore) Save(ctx context.Context, id string, from sfufleet.Phase, node sfufleet.Node) error {
	var address *netip.Addr
	if node.Address.IsValid() {
		address = &node.Address
	}
	count, err := s.queries.SetSFUWindowNodePhase(ctx, sqlc.SetSFUWindowNodePhaseParams{
		ID: id, FromPhase: string(from), NextPhase: string(node.Phase),
		ProviderID:       pgtype.Int8{Int64: node.ProviderID, Valid: node.ProviderID > 0},
		ControlAddress:   address,
		EmptySince:       pgtype.Timestamptz{Time: node.EmptySince, Valid: !node.EmptySince.IsZero()},
		EmptyIncarnation: pgtype.Text{String: node.EmptyIncarnation, Valid: node.EmptyIncarnation != ""},
	})
	return checkSFUWindowWrite(count, err)
}

func (s SFUWindowStore) Unbound(ctx context.Context, id string) (bool, error) {
	return s.queries.IsSFUWindowNodeUnbound(ctx, id)
}

func (s SFUWindowStore) ForgetIntent(ctx context.Context, id string) error {
	count, err := s.queries.ForgetSFUWindowIntent(ctx, id)
	return checkSFUWindowWrite(count, err)
}

func checkSFUWindowWrite(count int64, err error) error {
	if err != nil {
		return fmt.Errorf("write SFU window journal: %w", err)
	}
	if count != 1 {
		return errors.New("SFU window journal refused a phase or capacity change")
	}
	return nil
}

func mapSFUWindowBindingError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.ConstraintName == "sfu_window_node_accepting" {
		return fmt.Errorf("%w: %w: %w: window node draining", mediaplane.ErrPlaneUnavailable, mediaplane.ErrProviderRateLimited, mediaplane.ErrPlacementRefused)
	}
	return err
}
