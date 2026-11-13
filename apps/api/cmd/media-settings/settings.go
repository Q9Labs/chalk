package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

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
