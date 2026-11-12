package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/tenantpurge"
)

// inventory reads the database for a scope and prints, saves or exports the plan. It writes nothing to the database.
func inventory(ctx context.Context, repository postgres.TenantPurgeRepository, o options) error {
	if o.scope == "" {
		return errors.New("scope required for dry-run inventory")
	}
	var scope tenantpurge.Scope
	if err := readPrivate(o.scope, &scope); err != nil {
		return err
	}
	plan, err := snapshot(ctx, repository, scope, o)
	if err != nil {
		return err
	}
	if o.objects != "" {
		if err := attachObjects(ctx, repository, &plan, scope, o); err != nil {
			return err
		}
	}
	if o.planOut != "" {
		if err := writePrivate(o.planOut, plan.WithoutValues()); err != nil {
			return err
		}
	}
	if o.export {
		return json.NewEncoder(os.Stdout).Encode(plan)
	}
	return summarize(plan)
}

func snapshot(ctx context.Context, repository postgres.TenantPurgeRepository, scope tenantpurge.Scope, o options) (tenantpurge.Plan, error) {
	if o.operation != "backfill" {
		return repository.Snapshot(ctx, scope, o.export)
	}
	if o.backfill == "" {
		return tenantpurge.Plan{}, errors.New("explicit backfill file required")
	}
	var backfill tenantpurge.Backfill
	if err := readPrivate(o.backfill, &backfill); err != nil {
		return tenantpurge.Plan{}, err
	}
	return repository.SnapshotBackfill(ctx, scope, backfill, o.export)
}

func attachObjects(ctx context.Context, repository postgres.TenantPurgeRepository, plan *tenantpurge.Plan, scope tenantpurge.Scope, o options) error {
	var manifest tenantpurge.ObjectManifest
	if err := readPrivate(o.objects, &manifest); err != nil {
		return err
	}
	if err := manifest.Validate(scope); err != nil {
		return err
	}
	plan.Objects = &manifest
	if o.operation != "purge" {
		return errors.New("object manifests belong to purge plans only")
	}
	return repository.VerifyPurgeObjects(ctx, *plan)
}
