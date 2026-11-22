package main

import (
	"context"
	"database/sql"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

type rowQuerier interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

const retireVersion = 20261121120000

// legacyEpisode matches an Episode created before Chalk SFU: no binding key, or a Cloudflare provider
// ($1 is the Cloudflare SFU setting name). Keep it in step with the guard in
// 20261121120000_retire_cloudflare_media_plane.sql.
const legacyEpisode = `(not (e.config_snapshot ? 'media_plane_binding')
	or e.config_snapshot #>> '{media_plane_binding,provider}' in ($1, 'cf_rtk'))`

// runCutoverCheck is `chalk-migrate --check-cutover --database-url-file FILE`. It only reads, and exits 1 with
// the reason when the database is not ready for the release.
func runCutoverCheck(args []string) {
	if err := cutoverCheck(args); err != nil {
		fmt.Fprintf(os.Stderr, "cutover check failed: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("cutover check passed")
}

func isCutoverFlag(arg string) bool {
	name, _, _ := strings.Cut(strings.TrimLeft(arg, "-"), "=")
	return name == "check-cutover" && strings.HasPrefix(arg, "-")
}

func parseCutoverArgs(args []string) (string, error) {
	flags := flag.NewFlagSet("chalk-migrate", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	flags.Bool("check-cutover", false, "read-only: refuse when the database is not ready to retire Cloudflare media")
	databaseURLFile := flags.String("database-url-file", "", "file containing the dedicated migration database URL")
	if err := flags.Parse(args); err != nil {
		return "", err
	}
	if flags.NArg() != 0 || *databaseURLFile == "" || !filepath.IsAbs(*databaseURLFile) {
		return "", errors.New("--check-cutover takes only an absolute --database-url-file")
	}
	return *databaseURLFile, nil
}

func cutoverCheck(args []string) error {
	databaseURLFile, err := parseCutoverArgs(args)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), migrationTimeout)
	defer cancel()
	database, _, err := openDatabase(ctx, databaseURLFile)
	if err != nil {
		return err
	}
	defer database.Close()
	return verifyCutover(ctx, database)
}

// verifyCutover refuses a Cloudflare retirement the database is not ready for. The deploy controller runs it
// before it stops the runtime and again once the runtime is stopped; the migration keeps its own
// transactional guard for live Episodes.
//
// Legacy Episodes and their capture jobs are refused on every deploy: the release has no Cloudflare
// adapter, even when a rollback has put the old API back after the migration was applied. A paused
// new-Episodes switch is refused only until the retirement is applied, so an operator pause during an
// incident never blocks a later hotfix.
func verifyCutover(ctx context.Context, database rowQuerier) error {
	var live int
	if err := database.QueryRowContext(ctx, `select count(*) from episodes e
		where e.status in ('active', 'ending') and `+legacyEpisode, mediaplane.PlaneCloudflare).Scan(&live); err != nil {
		return errors.New("inspect live Cloudflare Episodes")
	}
	if live > 0 {
		return fmt.Errorf("%d active or ending Cloudflare Episodes: end them before retiring Cloudflare media", live)
	}

	var unfinished int
	if err := database.QueryRowContext(ctx, `select count(*) from recording_jobs j
		join episodes e on e.id = j.episode_id
		where j.kind = 'capture' and j.state in ('pending', 'leased', 'retryable_failure') and `+legacyEpisode, mediaplane.PlaneCloudflare).Scan(&unfinished); err != nil {
		return errors.New("inspect Cloudflare capture jobs")
	}
	if unfinished > 0 {
		return fmt.Errorf("%d unfinished capture jobs for Cloudflare Episodes: let them finish or cancel them first", unfinished)
	}

	pending, err := retirementPending(ctx, database)
	if err != nil || !pending {
		return err
	}
	return checkNewEpisodesResumed(ctx, database)
}

func retirementPending(ctx context.Context, database rowQuerier) (bool, error) {
	var tracked bool
	if err := database.QueryRowContext(ctx, `select to_regclass('goose_db_version') is not null`).Scan(&tracked); err != nil || !tracked {
		return false, wrapInspect(err, "migration history")
	}
	var applied bool
	if err := database.QueryRowContext(ctx, `select exists (select 1 from goose_db_version where version_id = $1 and is_applied)`, retireVersion).Scan(&applied); err != nil {
		return false, wrapInspect(err, "migration history")
	}
	return !applied, nil
}

// checkNewEpisodesResumed reads the switch in its own query: Postgres resolves a relation name before
// it evaluates to_regclass, so one statement would fail on a database that predates the table.
func checkNewEpisodesResumed(ctx context.Context, database rowQuerier) error {
	var exists bool
	if err := database.QueryRowContext(ctx, `select to_regclass('media_plane_kill_switch') is not null`).Scan(&exists); err != nil {
		return wrapInspect(err, "the new-Episodes switch")
	}
	if !exists {
		return nil
	}
	var paused bool
	if err := database.QueryRowContext(ctx, `select coalesce((select paused from media_plane_kill_switch where singleton), false)`).Scan(&paused); err != nil {
		return wrapInspect(err, "the new-Episodes switch")
	}
	if paused {
		return errors.New("new Episodes are paused: resume them before the cutover so the release starts in a known state")
	}
	return nil
}

func wrapInspect(err error, what string) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("inspect %s", what)
}
