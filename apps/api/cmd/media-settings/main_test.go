package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const someID = "11111111-1111-4111-8111-111111111111"

func TestParseRequestRefusesWhatItCannotDo(t *testing.T) {
	bad := []struct {
		name                          string
		command, tenant, space, plane string
		dryRun                        bool
		want                          string
	}{
		{"no such command", "drop", someID, "", "", false, "usage"},
		{"set without a plane", "set", someID, "", "", false, "--plane"},
		{"set with an unknown plane", "set", someID, "", "other", false, "--plane must be"},
		{"set without a Tenant", "set", "", "", "chalk_sfu", false, "--tenant"},
		{"get with a plane", "get", someID, "", "chalk_sfu", false, "--plane applies to set"},
		{"get with a malformed Space", "get", someID, "nope", "", false, "--space"},
		{"dry run on set", "set", someID, "", "inherit", true, "--dry-run"},
		{"backfill aimed at a Tenant", "backfill", someID, "", "", false, "takes no"},
	}
	for _, c := range bad {
		if _, err := parseRequest(c.command, c.tenant, c.space, c.plane, c.dryRun); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: err = %v, want %q", c.name, err, c.want)
		}
	}
	inherit, err := parseRequest("set", someID, someID, "inherit", false)
	if err != nil || inherit.plane != nil || inherit.space.IsZero() {
		t.Fatalf("inherit = %+v, %v", inherit, err)
	}
	own, err := parseRequest("set", someID, "", "chalk_sfu", false)
	if err != nil || own.plane == nil || *own.plane != spaces.MediaPlaneProviderChalkSFU {
		t.Fatalf("chalk_sfu = %+v, %v", own, err)
	}
}

func TestBackfillNeedsTheStatedAllowlist(t *testing.T) {
	t.Setenv(config.DatabaseURL, "postgres://invalid.example/none")
	if err := os.Unsetenv(config.ChalkSFUAllowedSpaces); err != nil {
		t.Fatal(err)
	}
	if err := run(context.Background(), []string{"backfill", "--dry-run"}, &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), config.ChalkSFUAllowedSpaces) {
		t.Fatalf("err = %v, want a demand to state %s", err, config.ChalkSFUAllowedSpaces)
	}
}

func lines(t *testing.T, out *bytes.Buffer) []map[string]any {
	t.Helper()
	var result []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		if line == "" {
			continue
		}
		entry := map[string]any{}
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			t.Fatalf("log line %q: %v", line, err)
		}
		result = append(result, entry)
	}
	return result
}

func TestOperatorCommandsAgainstPostgres(t *testing.T) {
	url := os.Getenv(config.DatabaseURL)
	if url == "" {
		t.Skip(config.DatabaseURL + " is not set")
	}
	pool, err := pgxpool.New(t.Context(), url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(t.Context()); err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	// This test commits Tenants and Spaces that the inventory command's tests count, so the
	// two take the same lock. Closing the connection releases it.
	lock, err := pgx.Connect(t.Context(), url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { lock.Close(context.Background()) })
	if _, err := lock.Exec(t.Context(), `select pg_advisory_lock(7710001)`); err != nil {
		t.Fatal(err)
	}
	newID := func() utilities.ID {
		id, err := utilities.NewID()
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	tenantID, listed, unlisted, tenantManaged := newID(), newID(), newID(), newID()
	otherTenant := newID()
	exec := func(statement string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(t.Context(), statement, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`insert into tenants (id,name) values ($1,'Settings CLI proof')`, tenantID.Bytes())
	exec(`insert into tenants (id,name,media_plane_provider_config) values ($1,'Settings CLI own credentials','{"provider":"cf_sfu","mode":"tenant_managed"}'::jsonb)`, otherTenant.Bytes())
	exec(`insert into tenant_artifact_policies(tenant_id) values ($1),($2)`, tenantID.Bytes(), otherTenant.Bytes())
	t.Cleanup(func() {
		for _, tenant := range []utilities.ID{tenantID, otherTenant} {
			for _, statement := range []string{`delete from spaces where tenant_id=$1`, `delete from tenants where id=$1`} {
				if _, err := pool.Exec(context.Background(), statement, tenant.Bytes()); err != nil {
					t.Errorf("clean up: %v", err)
				}
			}
		}
	})
	for _, space := range []struct {
		id, tenant utilities.ID
		stored     string
	}{{listed, tenantID, "chalk_sfu"}, {unlisted, tenantID, "chalk_sfu"}, {tenantManaged, otherTenant, "chalk_sfu"}} {
		exec(`insert into spaces (id,tenant_id,name,slug,media_plane) values ($1,$2,'Settings CLI proof',$3,$4)`, space.id.Bytes(), space.tenant.Bytes(), "s-"+space.id.String()[:8], space.stored)
	}
	t.Setenv(config.DefaultMediaPlane, "cf_sfu")
	t.Setenv(config.ChalkSFUAllowedSpaces, listed.String()+","+tenantManaged.String())
	t.Setenv(config.ChalkSFUNewEpisodes, "on")

	invoke := func(args ...string) []map[string]any {
		t.Helper()
		var out bytes.Buffer
		if err := run(t.Context(), args, &out); err != nil {
			t.Fatalf("%v: %v (tenant=%s listed=%s unlisted=%s managed=%s other=%s)", args, err, tenantID, listed, unlisted, tenantManaged, otherTenant)
		}
		return lines(t, &out)
	}
	settingOf := func(id utilities.ID) (setting *string, stored string) {
		t.Helper()
		if err := pool.QueryRow(t.Context(), `select media_plane_setting, media_plane from spaces where id=$1`, id.Bytes()).Scan(&setting, &stored); err != nil {
			t.Fatal(err)
		}
		return setting, stored
	}

	// A dry run lists and writes nothing.
	dry := invoke("backfill", "--dry-run")
	summary := dry[len(dry)-1]
	if summary["dry_run"] != true || summary["off_allowlist"].(float64) < 1 || summary["refused_tenant"].(float64) < 1 || summary["changed"].(float64) != 1 {
		t.Fatalf("dry-run summary = %v", summary)
	}
	if setting, _ := settingOf(listed); setting != nil {
		t.Fatalf("a dry run wrote %q", *setting)
	}

	// The real run sets the listed Space and skips the unlisted one and the Tenant that cannot serve the plane.
	invoke("backfill")
	if setting, stored := settingOf(listed); setting == nil || *setting != "chalk_sfu" || stored != "chalk_sfu" {
		t.Fatalf("listed Space after backfill = %v/%q", setting, stored)
	}
	if setting, _ := settingOf(unlisted); setting != nil {
		t.Fatalf("an unlisted Space was backfilled: %q", *setting)
	}
	if setting, _ := settingOf(tenantManaged); setting != nil {
		t.Fatalf("a Tenant with its own credentials was backfilled: %q", *setting)
	}
	again := invoke("backfill")
	if changed := again[len(again)-1]["changed"].(float64); changed != 0 {
		t.Fatalf("a second backfill changed %v Spaces: %v", changed, again)
	}

	// Tenant and Space writes log one line each, with before and after.
	got := invoke("set", "--tenant", tenantID.String(), "--plane", "chalk_sfu")
	if len(got) != 1 || got[0]["before"] != "inherit" || got[0]["after"] != "chalk_sfu" || got[0]["scope"] != "tenant" {
		t.Fatalf("tenant set = %v", got)
	}
	got = invoke("set", "--tenant", tenantID.String(), "--space", listed.String(), "--plane", "inherit")
	if len(got) != 1 || got[0]["before"] != "chalk_sfu" || got[0]["after"] != "inherit" {
		t.Fatalf("space clear = %v", got)
	}
	if setting, stored := settingOf(listed); setting != nil || stored != "cf_sfu" {
		t.Fatalf("cleared Space = %v/%q, want null and the platform default", setting, stored)
	}
	if got = invoke("get", "--tenant", tenantID.String(), "--space", listed.String()); got[0]["effective_plane"] != "chalk_sfu" || got[0]["tenant_default"] != "chalk_sfu" {
		t.Fatalf("get = %v", got)
	}
	invoke("set", "--tenant", tenantID.String(), "--plane", "inherit")
	if got = invoke("get", "--tenant", tenantID.String(), "--space", listed.String()); got[0]["effective_plane"] != "cf_sfu" {
		t.Fatalf("get after undo = %v", got)
	}

	// A value no operator approved never selects the own SFU, and an operator can repair one
	// that names no plane at all, with the raw value in the audit line.
	exec(`update tenants set default_media_plane='chalk_sfu' where id=$1`, tenantID.Bytes())
	if got = invoke("get", "--tenant", tenantID.String(), "--space", listed.String()); got[0]["effective_plane"] != "cf_sfu" {
		t.Fatalf("an unapproved legacy chalk_sfu default selected %v", got[0]["effective_plane"])
	}
	exec(`update tenants set default_media_plane='bogus' where id=$1`, tenantID.Bytes())
	if got = invoke("get", "--tenant", tenantID.String(), "--space", listed.String()); got[0]["effective_plane"] != "cf_sfu" {
		t.Fatalf("an unknown legacy default broke the resolution: %v", got)
	}
	if got = invoke("set", "--tenant", tenantID.String(), "--plane", "inherit"); got[0]["before"] != "bogus" || got[0]["after"] != "inherit" {
		t.Fatalf("clearing an unknown legacy default = %v", got)
	}

	// The backfill writes only a Space that still qualifies when the write runs.
	exec(`update spaces set media_plane_setting_written=null, media_plane_setting_against=null, media_plane='chalk_sfu' where id=$1`, listed.Bytes())
	settings := newSettings(pool, spaces.PlanePolicy{Platform: spaces.MediaPlaneProviderCloudflareSFU}, &bytes.Buffer{})
	exec(`update spaces set media_plane_setting_written='cf_sfu', media_plane_setting_against='cf_sfu', media_plane='cf_sfu' where id=$1`, listed.Bytes())
	if wrote, err := settings.operator.AdoptStoredChalkSFU(t.Context(), tenantID, listed, false); err != nil || wrote {
		t.Fatalf("a Space that pinned Cloudflare after it was listed: wrote=%v err=%v", wrote, err)
	}
	if setting, _ := settingOf(listed); setting == nil || *setting != "cf_sfu" {
		t.Fatalf("the backfill overwrote the Space owner's choice: %v", setting)
	}

	// The own SFU is refused for a Tenant that runs its own credentials.
	var out bytes.Buffer
	err = run(t.Context(), []string{"set", "--tenant", otherTenant.String(), "--plane", "chalk_sfu"}, &out)
	if err == nil || !strings.Contains(err.Error(), spaces.ErrTenantCannotServePlane.Error()) {
		t.Fatalf("set on a Tenant with its own credentials: %v", err)
	}
}
