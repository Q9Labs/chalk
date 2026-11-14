package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/publicinviteapp"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// Replays the formal finding ArchiveLeavesNoActiveEpisode (tools/formal/public-invite-access). The
// auto Space lifecycle worker asks to end the live Episode and then archives the Space, in two
// separate steps. A public join that lands between them creates a new Episode, and ArchiveSpace
// does not look at Episodes. This test pins today's behavior: when the finding is fixed, it fails,
// and the finding moves out of `findings` in the same change.
func TestFormalFindingArchiveLeavesActiveEpisode(t *testing.T) {
	databaseURL := os.Getenv(config.DatabaseURL)
	if testing.Short() || databaseURL == "" {
		t.Skip("isolated PostgreSQL integration database is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	tenantID, accountID := accountTenantIntegrationID(t), accountTenantIntegrationID(t)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`insert into users(id,name,email) values($1,'Archive replay host',$2)`, uuid(accountID), accountID.String()+"@archive-replay.test")
	exec(`insert into tenants(id,name) values($1,'Archive replay fixture')`, uuid(tenantID))
	exec(`insert into tenant_artifact_policies(tenant_id) values($1)`, uuid(tenantID))
	spaceService := spaces.NewService(NewSpaceRepository(sqlc.New(pool), pool))
	space, err := spaceService.CreateSpace(ctx, spaces.CreateSpaceInput{
		TenantID: tenantID, Name: "Archive replay", Slug: "archive-replay-" + accountTenantIntegrationID(t).String(),
		MediaPlane: "cf_sfu", AdmissionPolicy: json.RawMessage(`{"mode":"open"}`),
		DefaultEpisodeDurationSeconds: 3600, MaximumEpisodeDurationSeconds: 86400, LingerWindowSeconds: 60,
		RequestKey: accountTenantIntegrationID(t).String(),
	})
	if err != nil {
		t.Fatal(err)
	}
	episodeService := episodes.NewService(NewEpisodeLifecycleRepository(pool))
	actions, err := publicinviteapp.NewLifecycleActions(episodeService, spaceService)
	if err != nil {
		t.Fatal(err)
	}
	input := publicinvites.LifecycleActionInput{TenantID: tenantID, SpaceID: space.ID, RequestKey: accountTenantIntegrationID(t).String()}

	// Step 1 of the worker: no Episode is live yet, so there is nothing to end.
	if err := actions.EndEpisode(ctx, input); err != nil {
		t.Fatal(err)
	}
	// A guest joins before step 2. The join creates the Episode.
	guest, err := episodeService.JoinPublic(ctx, episodes.PublicJoinInput{
		TenantID: tenantID, SpaceID: space.ID, AccountID: accountID, IdentityMode: "account", DisplayName: "Late guest", Role: "owner",
		Request: episodes.Request{Key: accountTenantIntegrationID(t).String()},
	})
	if err != nil {
		t.Fatal(err)
	}
	// Step 2 of the worker: archive the Space.
	input.RequestKey = accountTenantIntegrationID(t).String()
	if err := actions.ArchiveSpace(ctx, input); err != nil {
		t.Fatal(err)
	}

	var archived bool
	var status string
	if err := pool.QueryRow(ctx, `select spaces.archived_at is not null, episodes.status from spaces join episodes on episodes.tenant_id=spaces.tenant_id and episodes.space_id=spaces.id where spaces.tenant_id=$1 and spaces.id=$2 and episodes.id=$3`,
		uuid(tenantID), uuid(space.ID), uuid(guest.Episode.ID)).Scan(&archived, &status); err != nil {
		t.Fatal(err)
	}
	if !archived || status != string(episodes.EpisodeStatusActive) {
		t.Fatalf("archived = %v, Episode status = %q; the finding no longer reproduces, so move ArchiveLeavesNoActiveEpisode out of findings", archived, status)
	}
	t.Logf("finding reproduced: Space archived while Episode %s is %s", guest.Episode.ID, status)
}

// publicInviteFixture is a Space with a public invite, an arrival and the services that act on them.
type publicInviteFixture struct {
	ctx           context.Context
	pool          *pgxpool.Pool
	tenantID      utilities.ID
	accountID     utilities.ID
	space         spaces.Space
	spaceService  spaces.Service
	service       publicinvites.Service
	arrivalHandle utilities.ID
}

func newPublicInviteFixture(t *testing.T, mode string) publicInviteFixture {
	t.Helper()
	databaseURL := os.Getenv(config.DatabaseURL)
	if testing.Short() || databaseURL == "" {
		t.Skip("isolated PostgreSQL integration database is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	tenantID, accountID := accountTenantIntegrationID(t), accountTenantIntegrationID(t)
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{`insert into users(id,name,email) values($1,'Invite fixture host',$2)`, []any{uuid(accountID), accountID.String() + "@invite-fixture.test"}},
		{`insert into tenants(id,name) values($1,'Invite fixture')`, []any{uuid(tenantID)}},
		{`insert into tenant_artifact_policies(tenant_id) values($1)`, []any{uuid(tenantID)}},
	} {
		if _, err := pool.Exec(ctx, statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	spaceService := spaces.NewService(NewSpaceRepository(sqlc.New(pool), pool))
	space, err := spaceService.CreateSpace(ctx, spaces.CreateSpaceInput{
		TenantID: tenantID, Name: "Invite fixture", Slug: "invite-fixture-" + accountTenantIntegrationID(t).String(),
		MediaPlane: "cf_sfu", AdmissionPolicy: json.RawMessage(`{"mode":"` + mode + `"}`),
		DefaultEpisodeDurationSeconds: 3600, MaximumEpisodeDurationSeconds: 86400, LingerWindowSeconds: 60,
		RequestKey: accountTenantIntegrationID(t).String(),
	})
	if err != nil {
		t.Fatal(err)
	}
	service := publicinvites.NewService(NewPublicInviteRepositoryWithPool(pool))
	admission := publicinvites.AdmissionKnock
	if mode == "open" {
		admission = publicinvites.AdmissionOpen
	}
	invite, err := service.EnsureInvite(ctx, tenantID, space.ID, accountID, admission)
	if err != nil {
		t.Fatal(err)
	}
	arrival, err := service.CreateArrival(ctx, publicinvites.CreateArrivalInput{
		TenantID: tenantID, SpaceID: space.ID,
		Invite: publicinvites.Token{Handle: invite.Handle, Generation: invite.Generation}, InviteStateEpoch: invite.StateEpoch,
		IdentityMode: publicinvites.IdentityGuest, DisplayName: "Invite fixture guest", GuestCredential: []byte("invite-fixture-guest-credential"),
		IdempotencyKey: accountTenantIntegrationID(t).String(),
	})
	if err != nil {
		t.Fatal(err)
	}
	return publicInviteFixture{ctx: ctx, pool: pool, tenantID: tenantID, accountID: accountID, space: space, spaceService: spaceService, service: service, arrivalHandle: arrival.Arrival.ArrivalHandle}
}

// An archived Space takes no new knock and no new open-Space join (PublicInviteAccess rule
// NoNewAccessInArchivedSpace).
func TestPublicInviteArchivedSpaceTakesNoGuests(t *testing.T) {
	t.Run("knock", func(t *testing.T) {
		f := newPublicInviteFixture(t, "knock")
		if _, err := f.spaceService.ArchiveSpace(f.ctx, f.tenantID, f.space.ID); err != nil {
			t.Fatal(err)
		}
		_, err := f.service.CreateAdmissionRequest(f.ctx, publicinvites.CreateAdmissionRequestInput{ArrivalHandle: f.arrivalHandle, DisplayName: "Invite fixture guest"})
		if !errors.Is(err, publicinvites.ErrInviteUnavailable) {
			t.Fatalf("knock in an archived Space = %v, want %v", err, publicinvites.ErrInviteUnavailable)
		}
	})
	t.Run("open join", func(t *testing.T) {
		f := newPublicInviteFixture(t, "open")
		if _, err := f.spaceService.ArchiveSpace(f.ctx, f.tenantID, f.space.ID); err != nil {
			t.Fatal(err)
		}
		_, err := episodes.NewService(NewEpisodeLifecycleRepository(f.pool)).JoinPublic(f.ctx, episodes.PublicJoinInput{
			TenantID: f.tenantID, SpaceID: f.space.ID, AccountID: f.accountID, IdentityMode: "account", DisplayName: "Late guest", Role: "collaborator",
			Request: episodes.Request{Key: accountTenantIntegrationID(t).String()},
		})
		if !errors.Is(err, episodes.ErrAdmissionClosed) {
			t.Fatalf("join in an archived Space = %v, want %v", err, episodes.ErrAdmissionClosed)
		}
	})
}

// An unavailable arrival never changes again (PublicInviteAccess rule TerminalStays). The open-Space
// grant writes the arrival without RequirePending, so only the transition table guards it.
func TestPublicArrivalTerminalStateStays(t *testing.T) {
	f := newPublicInviteFixture(t, "open")
	if _, err := f.service.UpdateArrivalState(f.ctx, publicinvites.UpdateArrivalStateInput{
		TenantID: f.tenantID, ArrivalHandle: f.arrivalHandle, State: publicinvites.ArrivalUnavailable, Reason: "formal_fixture",
	}); err != nil {
		t.Fatal(err)
	}
	_, err := f.service.UpdateArrivalState(f.ctx, publicinvites.UpdateArrivalStateInput{
		TenantID: f.tenantID, ArrivalHandle: f.arrivalHandle, State: publicinvites.ArrivalAdmitted, Reason: "formal_fixture",
		EpisodeID: accountTenantIntegrationID(t), ParticipantID: accountTenantIntegrationID(t), ParticipantGeneration: 1,
		Provider: "formal", ProviderSubject: "formal-subject",
	})
	if !errors.Is(err, publicinvites.ErrArrivalUnavailable) {
		t.Fatalf("admitting an unavailable arrival = %v, want %v", err, publicinvites.ErrArrivalUnavailable)
	}
	arrival, err := f.service.GetArrival(f.ctx, f.arrivalHandle)
	if err != nil || arrival.State != publicinvites.ArrivalUnavailable {
		t.Fatalf("arrival after the refused write = %+v, %v; want unavailable", arrival, err)
	}
}
