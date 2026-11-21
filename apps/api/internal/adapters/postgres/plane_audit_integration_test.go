package postgres

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const proofTraceID = "0123456789abcdef0123456789abcdef"

func operatorContext(t *testing.T, actor, reason string) context.Context {
	t.Helper()
	return mediaplane.WithChangeOrigin(t.Context(), mediaplane.ChangeOrigin{Actor: actor, Reason: reason, TraceID: proofTraceID})
}

// seedArtifactPolicy gives the Tenant the policy row every real Tenant has, which UpdateTenant joins.
func seedArtifactPolicy(t *testing.T, pool *pgxpool.Pool, tenant utilities.ID) {
	t.Helper()
	mustExec(t, pool, `insert into tenant_artifact_policies (tenant_id) values ($1) on conflict do nothing`, tenant.Bytes())
	t.Cleanup(func() { mustExec(t, pool, `delete from tenant_artifact_policies where tenant_id=$1`, tenant.Bytes()) })
}

type trailRow struct {
	Scope, Old, New, Actor, Reason, Trace string
}

// trailOf is the Tenant's rows of media_plane_changes, oldest first.
func trailOf(t *testing.T, pool *pgxpool.Pool, tenant utilities.ID) []trailRow {
	t.Helper()
	rows, err := pool.Query(t.Context(), `select scope, old_plane, new_plane, actor, reason, coalesce(trace_id, '') from media_plane_changes where tenant_id = $1 order by id`, tenant.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var trail []trailRow
	for rows.Next() {
		var row trailRow
		if err := rows.Scan(&row.Scope, &row.Old, &row.New, &row.Actor, &row.Reason, &row.Trace); err != nil {
			t.Fatal(err)
		}
		trail = append(trail, row)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return trail
}

func expectTrail(t *testing.T, got, want []trailRow) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("trail = %+v, want %+v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("trail[%d] = %+v, want %+v", i, got[i], want[i])
		}
	}
}

// Every writer leaves a row in the transaction of its change: the operator command with its
// name and reason, a public API request with its credential, and a writer that says nothing,
// such as the previous release writing the legacy column, as "unattributed". An undo is one
// more row, and a write that changes no plane leaves none.
func TestEveryPlaneWriterLeavesARow(t *testing.T) {
	pool := settingsPool(t)
	tenant, space := seedSettingsSpace(t, pool, nil, nil, mediaplane.PlaneCloudflare)
	if got := trailOf(t, pool, tenant); len(got) != 0 {
		t.Fatalf("seeding a Tenant and Space on no plane left rows: %+v", got)
	}
	chalk, cloudflare := mediaplane.PlaneChalk, mediaplane.PlaneCloudflare
	seedArtifactPolicy(t, pool, tenant)

	// The operator command sets the Tenant default and says why.
	if _, err := NewTenantOperator(pool).SetDefaultMediaPlane(operatorContext(t, "hasan", "pilot"), tenant, &chalk); err != nil {
		t.Fatal(err)
	}
	// A public API request moves the Space, named after its credential.
	key, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	request := authentication.ContextWithPrincipal(t.Context(), authentication.Principal{Kind: authentication.PrincipalAPIKey, TenantID: tenant, APIKeyID: key})
	cf := mediaplane.Provider("cf_sfu")
	repository := NewSpaceRepository(sqlc.New(pool), pool)
	if _, err := repository.UpdateSpace(request, tenant, space, spaces.UpdateSpaceInput{
		MediaPlane:        utilities.OptionalString{Set: true, Value: &cloudflare},
		MediaPlaneSetting: spaces.OptionalMediaPlaneSetting{Set: true, Value: &cf},
	}); err != nil {
		t.Fatal(err)
	}
	// An update of another field changes no plane and leaves no row.
	renamed := "Plane audit proof renamed"
	if _, err := repository.UpdateSpace(request, tenant, space, spaces.UpdateSpaceInput{Name: utilities.OptionalString{Set: true, Value: &renamed}}); err != nil {
		t.Fatal(err)
	}
	// The previous release writes only the legacy column, with no tag.
	mustExec(t, pool, `update spaces set media_plane='chalk_sfu', media_plane_setting_written=null, media_plane_setting_against=null where id=$1`, space.Bytes())
	// The undo is an ordinary change with its own reason.
	if _, err := NewTenantOperator(pool).SetDefaultMediaPlane(operatorContext(t, "hasan", "pilot over"), tenant, nil); err != nil {
		t.Fatal(err)
	}

	// A public Tenant update that sets the default plane is named after its credential too, and an
	// update of another field leaves no row.
	publicTenants := NewTenantRepository(sqlc.New(pool), pool)
	if _, err := publicTenants.UpdateTenant(request, tenant, tenants.UpdateTenantInput{DefaultMediaPlane: utilities.OptionalString{Set: true, Value: &cloudflare}}); err != nil {
		t.Fatal(err)
	}
	if _, err := publicTenants.UpdateTenant(request, tenant, tenants.UpdateTenantInput{Name: utilities.OptionalString{Set: true, Value: &renamed}}); err != nil {
		t.Fatal(err)
	}

	expectTrail(t, trailOf(t, pool, tenant), []trailRow{
		{"tenant", "inherit", mediaplane.PlaneChalk, "hasan", "pilot", proofTraceID},
		{"space", "inherit", mediaplane.PlaneCloudflare, "api_key:" + key.String(), "public API request", ""},
		{"space", mediaplane.PlaneCloudflare, mediaplane.PlaneChalk, "unattributed", "unattributed", ""},
		{"tenant", mediaplane.PlaneChalk, "inherit", "hasan", "pilot over", proofTraceID},
		{"tenant", "inherit", mediaplane.PlaneCloudflare, "api_key:" + key.String(), "public API request", ""},
	})
}

// The relay announces each change once, however often it runs.
func TestChangeLedgerAnnouncesEachChangeOnce(t *testing.T) {
	pool := settingsPool(t)
	tenant, _ := seedSettingsSpace(t, pool, nil, nil, mediaplane.PlaneCloudflare)
	chalk := mediaplane.PlaneChalk
	seedArtifactPolicy(t, pool, tenant)
	if _, err := NewTenantOperator(pool).SetDefaultMediaPlane(operatorContext(t, "hasan", "pilot"), tenant, &chalk); err != nil {
		t.Fatal(err)
	}
	ledger := NewChangeLedger(pool)
	announced := func() []mediaplane.Change {
		var mine []mediaplane.Change
		for {
			var batch []mediaplane.Change
			n, err := ledger.AnnounceChanges(t.Context(), 500, func(change mediaplane.Change) { batch = append(batch, change) })
			if err != nil {
				t.Fatal(err)
			}
			for _, change := range batch {
				if change.TenantID == tenant {
					mine = append(mine, change)
				}
			}
			if n < 500 {
				return mine
			}
		}
	}
	first := announced()
	if len(first) != 1 {
		t.Fatalf("first pass announced %+v, want the one change", first)
	}
	change := first[0]
	if change.Scope != mediaplane.ChangeScopeTenant || change.OldPlane != "inherit" || change.NewPlane != mediaplane.PlaneChalk || change.Actor != "hasan" || change.Reason != "pilot" || change.TraceID != proofTraceID || !change.SpaceID.IsZero() || change.ChangedAt.IsZero() {
		t.Fatalf("announced change = %+v", change)
	}
	if again := announced(); len(again) != 0 {
		t.Fatalf("second pass announced %+v, want nothing", again)
	}
}

// policyResolver binds an Episode to the plane the policy picks. The provider-specific
// guards (client capability, node room) are the Registry's and have their own tests.
type policyResolver struct{ policy spaces.PlanePolicy }

func (r policyResolver) ResolveBinding(ctx context.Context, tenant tenants.Tenant, space spaces.Space, _ mediaplane.ClientProviders) (*mediaplane.Binding, error) {
	live, _ := spaces.NewEpisodesPausedFrom(ctx)
	choice, err := r.policy.Paused(live).Effective(tenant, space)
	if err != nil {
		return nil, err
	}
	binding, err := mediaplane.NewBinding(choice.Plane, mediaplane.BindingSourceDeploymentDefault, "proof-app")
	if err != nil {
		return nil, err
	}
	binding, err = binding.SelectedBy(choice.By)
	return &binding, err
}
