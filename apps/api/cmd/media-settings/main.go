// media-settings is the operator's way to choose the media plane for a Tenant or a
// Space. The public API cannot select the own SFU, and no operator principal exists in
// production, so this command is the only write path to it. It logs one JSON line per
// change to stdout and keeps Tenant and Space IDs out of metrics.
//
//	media-settings get --tenant ID [--space ID]
//	media-settings set --tenant ID [--space ID] --plane cf_sfu|chalk_sfu|inherit
//	media-settings backfill [--dry-run]
//	media-settings new-episodes [--state on|off --operator NAME --reason TEXT]
//
// new-episodes is the kill switch of the own SFU, stored in the database so a flip needs
// no API restart. off sends every new Episode to Cloudflare; Episodes already on the own
// SFU keep running there. With --state it flips the switch and writes an audit row (who,
// why, before, after) in the same transaction; without it, it reads the switch.
//
// Run it with the same settings the API runs with: it reads CHALK_DATABASE_URL,
// CHALK_DEFAULT_MEDIA_PLANE, CHALK_SFU_ALLOWED_SPACES and CHALK_SFU_NEW_EPISODES.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := run(ctx, os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "media-settings:", err)
		os.Exit(1)
	}
}

const usage = "usage: media-settings get|set|backfill|new-episodes ... (see the file comment)"

func run(ctx context.Context, args []string, out io.Writer) error {
	if len(args) == 0 {
		return errors.New(usage)
	}
	command, args := args[0], args[1:]
	flags := flag.NewFlagSet("media-settings "+command, flag.ContinueOnError)
	tenantFlag := flags.String("tenant", "", "Tenant ID")
	spaceFlag := flags.String("space", "", "Space ID; omit to act on the Tenant")
	planeFlag := flags.String("plane", "", "cf_sfu, chalk_sfu, or inherit to clear (set only)")
	dryRun := flags.Bool("dry-run", false, "list the changes without writing them (backfill only)")
	stateFlag := flags.String("state", "", "on or off (new-episodes only); omit to read")
	operatorFlag := flags.String("operator", "", "who flips the switch (new-episodes --state only)")
	reasonFlag := flags.String("reason", "", "why (new-episodes --state only)")
	limit := flags.Duration("timeout", time.Minute, "whole-command deadline, at most 10 minutes")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || *limit <= 0 || *limit > 10*time.Minute {
		return errors.New("--timeout must be in (0, 10m] and no positional arguments are allowed")
	}
	var parsed request
	var err error
	switch {
	case command == "new-episodes":
		parsed, err = parseSwitchRequest(*tenantFlag, *spaceFlag, *planeFlag, *dryRun, *stateFlag, *operatorFlag, *reasonFlag)
	case *stateFlag != "" || *operatorFlag != "" || *reasonFlag != "":
		err = errors.New("--state, --operator and --reason apply to new-episodes only")
	default:
		parsed, err = parseRequest(command, *tenantFlag, *spaceFlag, *planeFlag, *dryRun)
	}
	if err != nil {
		return err
	}
	url := os.Getenv(config.DatabaseURL)
	if url == "" {
		return fmt.Errorf("%s required", config.DatabaseURL)
	}
	policy, err := config.LoadPlanePolicy()
	if err != nil {
		return err
	}
	if parsed.command == "backfill" {
		if _, set := os.LookupEnv(config.ChalkSFUAllowedSpaces); !set {
			return fmt.Errorf("state the allowlist the API runs with: set %s (empty means none)", config.ChalkSFUAllowedSpaces)
		}
	}

	ctx, cancel := context.WithTimeout(ctx, *limit)
	defer cancel()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return errors.New("open database")
	}
	defer pool.Close()
	return newSettings(pool, policy, out).execute(ctx, parsed)
}

type request struct {
	command string
	tenant  utilities.ID
	space   utilities.ID
	plane   *spaces.MediaPlaneProvider
	dryRun  bool
	// flip is set for new-episodes --state: paused is the value to write.
	flip     bool
	paused   bool
	operator string
	reason   string
}

func parseSwitchRequest(tenant, space, plane string, dryRun bool, state, operator, reason string) (request, error) {
	if tenant != "" || space != "" || plane != "" || dryRun {
		return request{}, errors.New("new-episodes takes only --state, --operator and --reason")
	}
	r := request{command: "new-episodes"}
	switch state {
	case "":
		if operator != "" || reason != "" {
			return request{}, errors.New("--operator and --reason apply to --state")
		}
		return r, nil
	case "on":
	case "off":
		r.paused = true
	default:
		return request{}, errors.New("--state must be on or off")
	}
	if strings.TrimSpace(operator) == "" || strings.TrimSpace(reason) == "" {
		return request{}, errors.New("flipping the switch needs --operator and --reason")
	}
	r.flip, r.operator, r.reason = true, strings.TrimSpace(operator), strings.TrimSpace(reason)
	return r, nil
}

func parseRequest(command, tenantText, spaceText, planeText string, dryRun bool) (request, error) {
	r := request{command: command, dryRun: dryRun}
	switch command {
	case "get", "set", "backfill":
	default:
		return request{}, errors.New(usage)
	}
	if command == "backfill" {
		if tenantText != "" || spaceText != "" || planeText != "" {
			return request{}, errors.New("backfill takes no --tenant, --space or --plane")
		}
		return r, nil
	}
	if dryRun {
		return request{}, errors.New("--dry-run applies to backfill only")
	}
	var err error
	if r.tenant, err = utilities.ParseID(tenantText); err != nil {
		return request{}, errors.New("--tenant must be a Tenant ID")
	}
	if spaceText != "" {
		if r.space, err = utilities.ParseID(spaceText); err != nil {
			return request{}, errors.New("--space must be a Space ID")
		}
	}
	if command == "get" {
		if planeText != "" {
			return request{}, errors.New("--plane applies to set only")
		}
		return r, nil
	}
	switch planeText {
	case "inherit":
	case "":
		return request{}, errors.New("set needs --plane cf_sfu, chalk_sfu or inherit")
	default:
		plane, err := spaces.ParseMediaPlaneProvider(planeText)
		if err != nil {
			return request{}, errors.New("--plane must be cf_sfu, chalk_sfu or inherit")
		}
		r.plane = &plane
	}
	return r, nil
}

type settings struct {
	pool       *pgxpool.Pool
	policy     spaces.PlanePolicy
	tenants    tenants.Service
	killSwitch postgres.KillSwitch
	spaces     spaces.Repository
	operator   spaces.PlaneOperator
	log        *slog.Logger
}

func newSettings(pool *pgxpool.Pool, policy spaces.PlanePolicy, out io.Writer) settings {
	queries := sqlc.New(pool)
	tenantService := tenants.NewService(postgres.NewTenantRepository(queries))
	spaceRepository := postgres.NewSpaceRepository(queries, pool)
	return settings{
		pool: pool, policy: policy, tenants: tenantService, spaces: spaceRepository, killSwitch: postgres.NewKillSwitch(pool),
		operator: spaces.NewPlaneOperator(spaceRepository, postgres.NewTenantOperator(pool), policy).WithAdopter(spaceRepository),
		log:      slog.New(slog.NewJSONHandler(out, nil)),
	}
}

func (s settings) execute(ctx context.Context, r request) error {
	switch r.command {
	case "get":
		return s.get(ctx, r)
	case "set":
		return s.set(ctx, r)
	case "new-episodes":
		return s.newEpisodes(ctx, r)
	default:
		return s.backfill(ctx, r.dryRun)
	}
}

func planeText(plane *spaces.MediaPlaneProvider) *string {
	if plane == nil {
		return nil
	}
	text := string(*plane)
	return &text
}

func valueOrInherit(value *string) string {
	if value == nil {
		return "inherit"
	}
	return *value
}

func (s settings) get(ctx context.Context, r request) error {
	tenant, err := s.tenants.GetTenant(ctx, r.tenant)
	if err != nil {
		return fmt.Errorf("read Tenant: %w", err)
	}
	live, err := s.killSwitch.NewEpisodesPaused(ctx)
	if err != nil {
		return err
	}
	policy := s.policy.Paused(live)
	attributes := []any{"scope", "tenant", "tenant_id", r.tenant.String(), "tenant_default", valueOrInherit(tenant.DefaultMediaPlane),
		"platform_default", string(s.policy.Platform), "kill_switch_on", policy.NewEpisodesPaused, "kill_switch_floor", s.policy.NewEpisodesPaused}
	if !r.space.IsZero() {
		space, err := s.spaces.GetSpace(ctx, r.tenant, r.space)
		if err != nil {
			return fmt.Errorf("read Space: %w", err)
		}
		effective, err := policy.Effective(tenant, space)
		if err != nil {
			return fmt.Errorf("resolve the effective plane: %w", err)
		}
		attributes = []any{"scope", "space", "tenant_id", r.tenant.String(), "space_id", r.space.String(),
			"space_setting", valueOrInherit(planeText(space.MediaPlaneSetting)), "space_stored_media_plane", space.MediaPlane,
			"tenant_default", valueOrInherit(tenant.DefaultMediaPlane), "platform_default", string(s.policy.Platform),
			"kill_switch_on", policy.NewEpisodesPaused, "kill_switch_floor", s.policy.NewEpisodesPaused, "on_allowlist", s.policy.Allowed.Allows(space.ID), "effective_plane", string(effective)}
	}
	s.log.Info("media plane settings", attributes...)
	return nil
}

func (s settings) newEpisodes(ctx context.Context, r request) error {
	if !r.flip {
		live, err := s.killSwitch.NewEpisodesPaused(ctx)
		if err != nil {
			return err
		}
		s.log.Info("media plane kill switch", "new_episodes", onOff(!live), "floor_new_episodes", onOff(!s.policy.NewEpisodesPaused))
		return nil
	}
	before, err := s.killSwitch.SetNewEpisodesPaused(ctx, r.paused, r.operator, r.reason)
	if err != nil {
		return err
	}
	s.log.Info("media plane kill switch changed", "event", "media_plane.kill_switch_changed", "operator", r.operator, "reason", r.reason,
		"before", onOff(!before), "after", onOff(!r.paused))
	return nil
}

func onOff(on bool) string {
	if on {
		return "on"
	}
	return "off"
}

func (s settings) set(ctx context.Context, r request) error {
	if r.space.IsZero() {
		change, err := s.operator.SetTenant(ctx, r.tenant, r.plane)
		if err != nil {
			return err
		}
		s.log.Info("media plane setting changed", "scope", "tenant", "tenant_id", r.tenant.String(), "before", valueOrInherit(change.Before), "after", valueOrInherit(change.After))
		return nil
	}
	change, err := s.operator.SetSpace(ctx, r.tenant, r.space, r.plane)
	if err != nil {
		return err
	}
	s.log.Info("media plane setting changed", "scope", "space", "tenant_id", r.tenant.String(), "space_id", r.space.String(), "before", valueOrInherit(change.Before), "after", valueOrInherit(change.After))
	return nil
}

// backfill moves the Spaces the allowlist selected before the setting existed onto the
// setting. A Space stored as chalk_sfu with no setting is already served by a read-time
// bridge, so this changes where the choice lives and not what any Space gets.
func (s settings) backfill(ctx context.Context, dryRun bool) error {
	rows, err := s.pool.Query(ctx, `select tenant_id, id from spaces where media_plane_setting is null and btrim(media_plane) = 'chalk_sfu' order by created_at, id`)
	if err != nil {
		return fmt.Errorf("list Spaces: %w", err)
	}
	type target struct{ tenant, space utilities.ID }
	var candidates []target
	for rows.Next() {
		var tenantBytes, spaceBytes [16]byte
		if err := rows.Scan(&tenantBytes, &spaceBytes); err != nil {
			rows.Close()
			return fmt.Errorf("read Space row: %w", err)
		}
		candidates = append(candidates, target{utilities.IDFromBytes(tenantBytes), utilities.IDFromBytes(spaceBytes)})
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("list Spaces: %w", err)
	}
	var changed, offAllowlist, refused, moved int
	for _, c := range candidates {
		if !s.policy.Allowed.Allows(c.space) {
			offAllowlist++
			continue
		}
		wrote, err := s.operator.AdoptStoredChalkSFU(ctx, c.tenant, c.space, dryRun)
		if errors.Is(err, spaces.ErrTenantCannotServePlane) {
			refused++
			s.log.Warn("media plane setting skipped", "scope", "space", "tenant_id", c.tenant.String(), "space_id", c.space.String(), "reason", err.Error())
			continue
		}
		if err != nil {
			return fmt.Errorf("set Space %s: %w", c.space, err)
		}
		if !wrote {
			moved++
			s.log.Warn("media plane setting skipped", "scope", "space", "tenant_id", c.tenant.String(), "space_id", c.space.String(), "reason", "the Space changed after it was listed")
			continue
		}
		changed++
		message := "media plane setting changed"
		if dryRun {
			message = "media plane setting would change"
		}
		s.log.Info(message, "scope", "space", "tenant_id", c.tenant.String(), "space_id", c.space.String(), "before", "inherit", "after", string(spaces.MediaPlaneProviderChalkSFU))
	}
	var unknownTenantDefaults, unapprovedOwnDefaults int
	if err := s.pool.QueryRow(ctx, `select count(*) from tenants where default_media_plane is not null and default_media_plane not in ('cf_sfu', 'chalk_sfu')`).Scan(&unknownTenantDefaults); err != nil {
		return fmt.Errorf("audit Tenant defaults: %w", err)
	}
	if err := s.pool.QueryRow(ctx, `select count(*) from tenants where default_media_plane = 'chalk_sfu' and not default_media_plane_approved`).Scan(&unapprovedOwnDefaults); err != nil {
		return fmt.Errorf("audit Tenant defaults: %w", err)
	}
	s.log.Info("media plane backfill finished", "dry_run", dryRun, "stored_as_chalk_sfu", len(candidates), "changed", changed,
		"off_allowlist", offAllowlist, "refused_tenant", refused, "changed_since_listed", moved,
		"tenants_with_unknown_default", unknownTenantDefaults, "tenants_with_unapproved_chalk_sfu_default", unapprovedOwnDefaults)
	return nil
}
