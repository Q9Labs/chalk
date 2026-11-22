package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

type rowQuerier interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// legacyEpisode matches an Episode created before Chalk SFU: no binding key, or a Cloudflare provider.
// Keep it in step with the guard in 20261121120000_retire_cloudflare_media_plane.sql.
const legacyEpisode = `(not (e.config_snapshot ? 'media_plane_binding')
	or e.config_snapshot #>> '{media_plane_binding,provider}' in ('cf_sfu', 'cf_rtk'))`

const retireVersion = 20261121120000

// verifyCutover runs checkCutover only while the retirement migration is still to be applied, so a
// later deploy is never refused over a state the cutover no longer depends on.
func verifyCutover(ctx context.Context, database rowQuerier) error {
	var tracked bool
	if err := database.QueryRowContext(ctx, `select to_regclass('goose_db_version') is not null`).Scan(&tracked); err != nil {
		return errors.New("inspect migration history")
	}
	if !tracked {
		return nil
	}
	var applied bool
	if err := database.QueryRowContext(ctx, `select exists (select 1 from goose_db_version where version_id = $1 and is_applied)`, retireVersion).Scan(&applied); err != nil {
		return errors.New("inspect migration history")
	}
	if applied {
		return nil
	}
	return checkCutover(ctx, database)
}

// checkCutover refuses a Cloudflare retirement the database is not ready for. It only reads, so the
// deploy controller runs it before it stops the runtime; the migration keeps its own transactional guard.
func checkCutover(ctx context.Context, database rowQuerier) error {
	var live int
	if err := database.QueryRowContext(ctx, `select count(*) from episodes e
		where e.status in ('active', 'ending') and `+legacyEpisode).Scan(&live); err != nil {
		return errors.New("inspect live Cloudflare Episodes")
	}
	if live > 0 {
		return fmt.Errorf("%d active or ending Cloudflare Episodes: end them before retiring Cloudflare media", live)
	}

	var unfinished int
	if err := database.QueryRowContext(ctx, `select count(*) from recording_jobs j
		join episodes e on e.id = j.episode_id
		where j.kind = 'capture' and j.state in ('pending', 'leased', 'retryable_failure') and `+legacyEpisode).Scan(&unfinished); err != nil {
		return errors.New("inspect Cloudflare capture jobs")
	}
	if unfinished > 0 {
		return fmt.Errorf("%d unfinished capture jobs for Cloudflare Episodes: let them finish or cancel them first", unfinished)
	}

	var paused bool
	if err := database.QueryRowContext(ctx, `select to_regclass('media_plane_kill_switch') is not null
		and coalesce((select paused from media_plane_kill_switch where singleton), false)`).Scan(&paused); err != nil {
		return errors.New("inspect the new-Episodes switch")
	}
	if paused {
		return errors.New("new Episodes are paused: resume them before the cutover so the release starts in a known state")
	}
	return nil
}
