package postgres

import (
	"context"
	"errors"
	"fmt"
	"net/netip"
	"time"

	"github.com/jackc/pgx/v5"
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
	db       sfuWindowDB
	queries  *sqlc.Queries
	firewall pgtype.UUID
}

type sfuWindowDB interface {
	sqlc.DBTX
	BeginTx(context.Context, pgx.TxOptions) (pgx.Tx, error)
}

type sfuWindowSpaceKey struct{ tenant, space [16]byte }

func NewSFUWindowStore(db sfuWindowDB, firewallID string) (SFUWindowStore, error) {
	var firewall pgtype.UUID
	if err := firewall.Scan(firewallID); err != nil || !firewall.Valid {
		return SFUWindowStore{}, errors.New("invalid SFU window provider firewall ID")
	}
	return SFUWindowStore{db: db, queries: sqlc.New(db), firewall: firewall}, nil
}

func (s SFUWindowStore) Load(ctx context.Context, application string, lookahead time.Duration, slotsPerNode int) (sfufleet.Snapshot, error) {
	// Match live Episodes, bookings and journal rows from one database snapshot.
	// Release the transaction before the controller makes any provider requests.
	var snapshot sfufleet.Snapshot
	err := pgx.BeginTxFunc(ctx, s.db, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly}, func(tx pgx.Tx) error {
		var err error
		snapshot, err = s.loadSnapshot(ctx, s.queries.WithTx(tx), application, lookahead, slotsPerNode)
		return err
	})
	if err != nil {
		return sfufleet.Snapshot{}, err
	}
	return snapshot, nil
}

func (s SFUWindowStore) loadSnapshot(ctx context.Context, queries *sqlc.Queries, application string, lookahead time.Duration, slotsPerNode int) (sfufleet.Snapshot, error) {
	now := time.Now().UTC()
	fingerprint, err := mediaplane.AdapterFingerprint(mediaplane.ProviderChalkSFU, application)
	if err != nil {
		return sfufleet.Snapshot{}, err
	}
	live, err := queries.ListSFULiveDemand(ctx, sqlc.ListSFULiveDemandParams{
		Provider: mediaplane.ProviderChalkSFU.SettingName(), Fingerprint: fingerprint,
	})
	if err != nil {
		return sfufleet.Snapshot{}, err
	}
	planned, err := queries.ListUpcomingScheduledEpisodes(ctx, sqlc.ListUpcomingScheduledEpisodesParams{
		WindowStart: timestamptzValue(now),
		WindowEnd:   timestamptzValue(now.Add(lookahead)),
	})
	if err != nil {
		return sfufleet.Snapshot{}, err
	}
	rows, err := queries.ListSFUWindowNodes(ctx, application)
	if err != nil {
		return sfufleet.Snapshot{}, err
	}
	nodeSeconds, err := queries.ReadSFUWindowNodeSeconds(ctx, sqlc.ReadSFUWindowNodeSecondsParams{
		ApplicationID: application, ObservedAt: timestamptz(&now), Since: timestamptzValue(now.Add(-31 * 24 * time.Hour)),
	})
	if err != nil {
		return sfufleet.Snapshot{}, err
	}

	demand := buildSFUWindowDemand(now, lookahead, slotsPerNode, live, planned)
	nodes, err := mapSFUWindowNodes(rows, s.firewall)
	if err != nil {
		return sfufleet.Snapshot{}, err
	}
	return sfufleet.Snapshot{
		ObservedAt: now,
		Demand:     demand,
		NodeTime:   time.Duration(nodeSeconds) * time.Second,
		Nodes:      nodes,
	}, nil
}

func buildSFUWindowDemand(now time.Time, lookahead time.Duration, slotsPerNode int, live []sqlc.ListSFULiveDemandRow, planned []sqlc.ListUpcomingScheduledEpisodesRow) sfufleet.Demand {
	liveSpaces, liveSlots := indexSFUWindowLiveDemand(live, slotsPerNode)
	return sfufleet.Demand{
		LiveSlots: liveSlots,
		Bookings:  buildSFUWindowBookings(now, lookahead, slotsPerNode, liveSpaces, planned),
	}
}

func indexSFUWindowLiveDemand(live []sqlc.ListSFULiveDemandRow, slotsPerNode int) (map[sfuWindowSpaceKey]sqlc.ListSFULiveDemandRow, int) {
	liveSpaces := make(map[sfuWindowSpaceKey]sqlc.ListSFULiveDemandRow, len(live))
	liveSlots := 0
	for _, episode := range live {
		liveSpaces[sfuWindowSpaceKey{episode.TenantID.Bytes, episode.SpaceID.Bytes}] = episode
		liveSlots += sfufleet.ClassSlots(int(episode.Participants), slotsPerNode)
	}
	return liveSpaces, liveSlots
}

func buildSFUWindowBookings(now time.Time, lookahead time.Duration, slotsPerNode int, liveSpaces map[sfuWindowSpaceKey]sqlc.ListSFULiveDemandRow, planned []sqlc.ListUpcomingScheduledEpisodesRow) []sfufleet.Booking {
	bookings := make([]sfufleet.Booking, 0, len(planned))
	for i := len(planned) - 1; i >= 0; i-- {
		booking := planned[i]
		if !mediaplane.TenantMediaEnabled(booking.MediaPlaneProviderConfig) {
			continue
		}
		start, end := booking.StartsAt.Time, booking.ExpectedEndsAt.Time
		key := sfuWindowSpaceKey{booking.TenantID.Bytes, booking.SpaceID.Bytes}
		covered := 0
		if episode, ok := liveSpaces[key]; ok && episode.StartedAt.Valid && !start.After(now) &&
			!episode.StartedAt.Time.Before(start.Add(-lookahead)) && episode.StartedAt.Time.Before(end) {
			covered = sfufleet.ClassSlots(int(episode.Participants), slotsPerNode)
			delete(liveSpaces, key)
		}
		bookings = append(bookings, sfufleet.Booking{
			StartsAt: start, EndsAt: end, Participants: int(booking.ParticipantCount), CoveredSlots: covered,
		})
	}
	return bookings
}

func mapSFUWindowNodes(rows []sqlc.SfuWindowNode, firewall pgtype.UUID) ([]sfufleet.Node, error) {
	nodes := make([]sfufleet.Node, 0, len(rows))
	for _, row := range rows {
		if row.ProviderFirewallID != firewall {
			return nil, errors.New("SFU window journal belongs to a different provider firewall")
		}
		var address netip.Addr
		if row.ControlAddress != nil {
			address = *row.ControlAddress
		}
		nodes = append(nodes, sfufleet.Node{
			ID: row.ID, ProviderID: row.ProviderID.Int64, Address: address, Phase: sfufleet.Phase(row.Phase),
			CreatedAt: row.CreatedAt.Time, EmptySince: row.EmptySince.Time, EmptyIncarnation: row.EmptyIncarnation.String,
		})
	}
	return nodes, nil
}

func (s SFUWindowStore) Reserve(ctx context.Context, application, id string, maxNodes int) error {
	count, err := s.queries.ReserveSFUWindowNode(ctx, sqlc.ReserveSFUWindowNodeParams{
		ID: id, ApplicationID: application, ProviderFirewallID: s.firewall, MaxNodes: int64(maxNodes),
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
	return s.queries.IsSFUWindowNodeUnbound(ctx, sqlc.IsSFUWindowNodeUnboundParams{
		Provider: mediaplane.ProviderChalkSFU.SettingName(), NodeID: id,
	})
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
