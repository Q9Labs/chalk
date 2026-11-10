package main

import (
	"bytes"
	"context"
	"encoding/json"
	"maps"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func shown(f Family) map[string]string {
	result := map[string]string{}
	for key, cell := range f {
		result[key] = cell.String()
	}
	return result
}

func TestPublishSuppressesSmallCellsAndHidesTheirSum(t *testing.T) {
	keys := []string{"a", "b", "c", "d"}
	families := publish(
		draft{counts{"a": 3, "b": 10, "c": 7, "d": 0}, keys},
		draft{counts{"a": 20, "b": 5, "c": 0, "d": 0}, keys},
	)
	// One small cell hides itself and the smallest remaining one in every family, so
	// no family leaves the population total readable.
	if want := map[string]string{"a": "<5", "b": "10", "c": "withheld", "d": "0"}; !maps.Equal(shown(families[0]), want) {
		t.Fatalf("first = %v, want %v", shown(families[0]), want)
	}
	if want := map[string]string{"a": "20", "b": "withheld", "c": "0", "d": "0"}; !maps.Equal(shown(families[1]), want) {
		t.Fatalf("second = %v, want %v", shown(families[1]), want)
	}
	// Two cells of 1 and a visible total of 12 must not reveal 1 and 1.
	pair := publish(draft{counts{"a": 1, "b": 1, "c": 10}, []string{"a", "b", "c"}})[0]
	if got := shown(pair); got["a"] != "<5" || got["b"] != "<5" || got["c"] != "withheld" {
		t.Fatalf("two small cells = %v, want <5, <5, withheld", got)
	}
	clear := publish(draft{counts{"a": 8, "b": 0}, []string{"a", "b"}})[0]
	if got := shown(clear); got["a"] != "8" || got["b"] != "0" {
		t.Fatalf("large cells = %v, want exact", got)
	}
	var encoded bytes.Buffer
	report := Report{Spaces: SpacesReport{ByNewEpisodeProvider: Family{"a": {n: 3, suppressed: true}, "b": {n: 12}}}}
	if err := report.writeJSON(&encoded); err != nil || !strings.Contains(encoded.String(), `"a": "<5"`) || !strings.Contains(encoded.String(), `"b": 12`) {
		t.Fatalf("json = %s, %v", encoded.String(), err)
	}
}

func TestRunRequiresStatedAllowlist(t *testing.T) {
	t.Setenv(config.ChalkSFUAllowedSpaces, "")
	if err := os.Unsetenv(config.ChalkSFUAllowedSpaces); err != nil {
		t.Fatal(err)
	}
	err := run(context.Background(), nil, &bytes.Buffer{}, &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), "allowlist") {
		t.Fatalf("run without allowlist = %v, want allowlist error", err)
	}
}

func testDatabaseURL() string {
	for _, name := range []string{"CHALK_SYNC_OVERHAUL_TEST_DATABASE_URL", config.DatabaseURL} {
		if value := os.Getenv(name); value != "" {
			return value
		}
	}
	return config.DefaultDatabaseURL
}

func connect(t *testing.T) (context.Context, *pgx.Conn) {
	t.Helper()
	if testing.Short() {
		t.Skip("postgres integration")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	t.Cleanup(cancel)
	connection, err := pgx.Connect(ctx, testDatabaseURL())
	if err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	t.Cleanup(func() { connection.Close(context.Background()) })
	// The counts here break when another package commits Tenants or Spaces meanwhile
	// (media-settings does). Closing the connection releases the lock.
	if _, err := connection.Exec(ctx, `select pg_advisory_lock(7710001)`); err != nil {
		t.Fatal(err)
	}
	return ctx, connection
}

func newID(t *testing.T) utilities.ID {
	t.Helper()
	id, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func delta(after, before counts) counts {
	result := counts{}
	for key, n := range after {
		if d := n - before[key]; d != 0 {
			result[key] = d
		}
	}
	return result
}

func expectCounts(t *testing.T, name string, got, want counts) {
	t.Helper()
	if !maps.Equal(got, want) {
		t.Errorf("%s = %v, want %v", name, got, want)
	}
}

const (
	tenantManagedCloudflare = `{"enabled":true,"provider":"cf_sfu","mode":"tenant_managed","cloudflare":{"account_id":"a","sfu":{"enabled":true,"app_id":"i","app_secret":"s"}}}`
	chalkManaged            = `{"enabled":true,"mode":"chalk_managed"}`
	disabledConfig          = `{"enabled":false,"mode":"chalk_managed"}`
)

// TestCollectCountsEveryResolutionCase seeds one case per way a Tenant or Space
// reaches a provider, in a transaction that is rolled back, and checks the
// change in each count so a shared database does not matter.
func TestCollectCountsEveryResolutionCase(t *testing.T) {
	ctx, connection := connect(t)
	tx, err := connection.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())

	a1, d2, e1, f1, i1 := newID(t), newID(t), newID(t), newID(t), newID(t)
	list, err := parseAllowlist(strings.Join([]string{a1.String(), d2.String(), e1.String(), f1.String(), i1.String()}, ","))
	if err != nil {
		t.Fatal(err)
	}
	before, err := collect(ctx, tx, list)
	if err != nil {
		t.Fatal(err)
	}

	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := tx.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("seed %q: %v", sql, err)
		}
	}
	tenant := func(defaultPlane *string, config string) utilities.ID {
		id := newID(t)
		var document any
		if config != "" {
			document = config
		}
		exec(`select set_config('chalk.operator_write', 'on', true)`)
		exec(`insert into tenants(id, name, default_media_plane, default_media_plane_approved, media_plane_provider_config) values($1, 'inventory', $2, coalesce($2::text = 'chalk_sfu', false), $3::jsonb)`, id.Bytes(), defaultPlane, document)
		exec(`select set_config('chalk.operator_write', 'off', true)`)
		return id
	}
	space := func(tenantID utilities.ID, mediaPlane string, archived bool, preset ...utilities.ID) utilities.ID {
		id := newID(t)
		if len(preset) > 0 {
			id = preset[0]
		}
		exec(`insert into spaces(id, name, tenant_id, slug, media_plane, archived_at) values($1, 'inventory', $2, $3, $4, case when $5 then now() end)`,
			id.Bytes(), tenantID.Bytes(), "inventory-"+id.String(), mediaPlane, archived)
		return id
	}
	episode := func(tenantID, spaceID utilities.ID, status, snapshot string) utilities.ID {
		id := newID(t)
		exec(`insert into episodes(id, status, space_id, tenant_id, config_snapshot) values($1, $2, $3, $4, $5::jsonb)`,
			id.Bytes(), status, spaceID.Bytes(), tenantID.Bytes(), snapshot)
		return id
	}
	recording := func(tenantID, spaceID, episodeID utilities.ID, pipelineState, transcriptionStatus string) {
		id := newID(t)
		exec(`insert into recordings(id, tenant_id, space_id, episode_id, status, storage_provider) values($1, $2, $3, $4, 'processing', 'cf')`,
			id.Bytes(), tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes())
		if pipelineState != "" {
			reservation := newID(t)
			exec(`insert into recording_reservations(id, tenant_id, space_id, episode_id, recording_id, idempotency_key, request_fingerprint, policy_snapshot_version, participant_count, max_duration_seconds, input_bitrate_bps, state, ends_at)
				values($1, $2, $3, $4, $5, $6, decode(repeat('00', 32), 'hex'), 'episode_config.v2', 1, 60, 1000, 'reserved', now() + interval '1 hour')`,
				reservation.Bytes(), tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes(), id.Bytes(), "inventory-"+id.String())
			exec(`insert into recording_pipelines(recording_id, tenant_id, reservation_id, state) values($1, $2, $3, $4)`, id.Bytes(), tenantID.Bytes(), reservation.Bytes(), pipelineState)
		}
		if transcriptionStatus != "" {
			exec(`insert into transcriptions(id, tenant_id, recording_id, space_id, episode_id, status, languages) values($1, $2, $3, $4, $5, $6, '{en}')`,
				newID(t).Bytes(), tenantID.Bytes(), id.Bytes(), spaceID.Bytes(), episodeID.Bytes(), transcriptionStatus)
		}
	}
	ptr := func(value string) *string { return &value }

	// A: default configuration, own SFU, on the allowlist.
	tenantA := tenant(nil, "")
	space(tenantA, "chalk_sfu", false, a1)
	// B: the Tenant default is Cloudflare and the Space inherits it.
	tenantB := tenant(ptr("cf_sfu"), "")
	b1 := space(tenantB, "", false)
	// C: explicit Cloudflare at Space level, an own-SFU Space outside the allowlist, an archived Space.
	tenantC := tenant(ptr("chalk_sfu"), chalkManaged)
	c1 := space(tenantC, "cf_sfu", false)
	c2 := space(tenantC, "chalk_sfu", false)
	space(tenantC, "cf_sfu", true)
	// D: tenant-managed Cloudflare. It runs on Cloudflare, and an own-SFU Space under it selects Cloudflare, as the resolver does.
	tenantD := tenant(nil, tenantManagedCloudflare)
	d1 := space(tenantD, "cf_sfu", false)
	space(tenantD, "chalk_sfu", false, d2)
	// E: media disabled for the Tenant.
	tenantE := tenant(nil, disabledConfig)
	space(tenantE, "chalk_sfu", false, e1)
	space(tenantE, "cf_sfu", false)
	// F: unreadable settings and an unknown Tenant default.
	tenantF := tenant(ptr("bogus"), `{}`)
	space(tenantF, "chalk_sfu", false, f1)
	// H: only an own-SFU Space outside the allowlist, which the API pins to Cloudflare.
	tenantH := tenant(nil, "")
	space(tenantH, "chalk_sfu", false)
	// I: a settings document the API cannot read, even though it names a mode.
	tenantI := tenant(nil, `{"mode":"chalk_managed","cloudflare":[]}`)
	space(tenantI, "chalk_sfu", false, i1)
	// J: tenant-managed Cloudflare with a numeric app_id.
	tenantJ := tenant(nil, `{"mode":"tenant_managed","provider":"cf_sfu","cloudflare":{"sfu":{"app_id":7,"app_secret":"s"}}}`)
	space(tenantJ, "cf_sfu", false)
	// G: a Space with a provider the API does not know.
	tenantG := tenant(nil, "")
	space(tenantG, "wat", false)

	// Live Episodes pinned to each kind of binding, one per Space, and an ended one.
	aEpisode := episode(tenantA, a1, "active", `{"media_plane_binding":{"provider":"chalk_sfu"}}`)
	bEpisode := episode(tenantB, b1, "active", `{"media_plane_binding":{"provider":"cf_sfu"}}`)
	cLegacy := episode(tenantC, c1, "active", `{}`)
	episode(tenantC, c2, "ending", `{"media_plane_binding":null}`)
	episode(tenantD, d1, "active", `{"media_plane_binding":{"provider":"other_sfu"}}`)
	dEnded := episode(tenantD, d2, "ended", `{"media_plane_binding":{"provider":"cf_sfu"}}`)
	// Recordings: Cloudflare with live capture and transcription, own SFU finished, legacy with neither.
	recording(tenantB, b1, bEpisode, "capturing_segmented", "transcribing")
	recording(tenantB, b1, bEpisode, "rendering", "")
	recording(tenantA, a1, aEpisode, "committed", "complete")
	recording(tenantC, c1, cLegacy, "", "")
	_ = dEnded

	after, err := collect(ctx, tx, list)
	if err != nil {
		t.Fatal(err)
	}
	expectCounts(t, "tenants by default plane", delta(after.Tenants.ByDefaultMediaPlane, before.Tenants.ByDefaultMediaPlane), counts{"none": 7, "cf_sfu": 1, "chalk_sfu": 1, "unknown": 1})
	expectCounts(t, "tenants by configuration source", delta(after.Tenants.ByConfigurationSource, before.Tenants.ByConfigurationSource),
		counts{"deployment_default": 4, "tenant_chalk_managed": 1, "tenant_managed": 1, "disabled": 1, "invalid": 3})
	expectCounts(t, "tenants by space selection", delta(after.Tenants.BySpaceSelection, before.Tenants.BySpaceSelection), counts{"has_cloudflare_space": 6, "no_cloudflare_space": 4})
	// A Space stored as cf_sfu with no setting inherits: the stored value is the platform default,
	// so the Tenant default (here chalk_sfu, off the allowlist) now decides.
	expectCounts(t, "spaces by selection", delta(after.Spaces.BySelection, before.Spaces.BySelection),
		counts{"space_chalk_sfu": 6, "space_cf_sfu": 4, "tenant_default_cf_sfu": 1, "tenant_default_chalk_sfu": 1, "space_unknown": 1})
	expectCounts(t, "spaces by new Episode provider", delta(after.Spaces.ByNewEpisodeProvider, before.Spaces.ByNewEpisodeProvider),
		counts{"chalk_sfu": 1, "cf_sfu": 3, "cf_sfu_by_allowlist": 3, "none": 2, "unresolvable": 4})
	expectCounts(t, "spaces by configuration source", delta(after.Spaces.ByConfigurationSource, before.Spaces.ByConfigurationSource),
		counts{"deployment_default": 4, "tenant_chalk_managed": 2, "tenant_managed": 2, "disabled": 2, "invalid": 3})
	expectCounts(t, "Cloudflare Spaces (selected or pinned) by configuration source", delta(after.Spaces.CloudflareByConfigSource, before.Spaces.CloudflareByConfigSource),
		counts{"deployment_default": 2, "tenant_chalk_managed": 2, "tenant_managed": 2, "disabled": 1, "invalid": 1})
	if got := after.Spaces.Archived - before.Spaces.Archived; got != 1 {
		t.Errorf("archived Spaces delta = %d, want 1", got)
	}
	expectCounts(t, "live Episodes", delta(after.Episodes.LiveByBoundProvider, before.Episodes.LiveByBoundProvider),
		counts{"chalk_sfu": 1, "cf_sfu": 1, "legacy_cf_sfu": 1, "none": 1, "other": 1})
	expectCounts(t, "Episodes created in 24h", delta(after.Episodes.CreatedLast24hByBoundProvider, before.Episodes.CreatedLast24hByBoundProvider),
		counts{"chalk_sfu": 1, "cf_sfu": 2, "legacy_cf_sfu": 1, "none": 1, "other": 1})
	expectCounts(t, "Recordings", delta(after.Dependencies.RecordingsByBoundProvider, before.Dependencies.RecordingsByBoundProvider),
		counts{"cf_sfu": 2, "chalk_sfu": 1, "legacy_cf_sfu": 1})
	expectCounts(t, "recording pipelines in flight", delta(after.Dependencies.RecordingPipelinesInFlightByProvider, before.Dependencies.RecordingPipelinesInFlightByProvider), counts{"cf_sfu": 1})
	expectCounts(t, "Transcriptions in flight", delta(after.Dependencies.TranscriptionsInFlightByProvider, before.Dependencies.TranscriptionsInFlightByProvider), counts{"cf_sfu": 1})
}

func TestRunPrintsStableSanitizedJSONAndTable(t *testing.T) {
	_, _ = connect(t)
	t.Setenv(config.DatabaseURL, testDatabaseURL())
	var first, second, table bytes.Buffer
	args := []string{"--allowed-spaces", "*", "--timeout", "30s"}
	if err := run(context.Background(), args, &first, &table); err != nil {
		t.Fatal(err)
	}
	if err := run(context.Background(), args, &second, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	var report struct {
		Schema    string `json:"schema"`
		Allowlist struct {
			Mode string `json:"mode"`
		} `json:"allowlist"`
	}
	if err := json.Unmarshal(first.Bytes(), &report); err != nil {
		t.Fatalf("output is not JSON: %v", err)
	}
	if report.Schema != "chalk.media_provider_inventory.v1" || report.Allowlist.Mode != "all" {
		t.Fatalf("report header = %+v", report)
	}
	if !strings.Contains(table.String(), "spaces.by_new_episode_provider.chalk_sfu") {
		t.Fatalf("table lacks the Space provider row:\n%s", table.String())
	}
	if first.String() != second.String() {
		t.Fatalf("two runs on one database differ:\n%s\n%s", first.String(), second.String())
	}
}
