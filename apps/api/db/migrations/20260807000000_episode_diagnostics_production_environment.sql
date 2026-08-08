-- +goose Up

-- Production joins the closed diagnostics environment vocabulary now that
-- hosted Episode Diagnostics can be enabled there behind
-- CHALK_EPISODE_DIAGNOSTICS_PRODUCTION_OPT_IN. The configuration layer stays
-- the only gate; these constraints only mirror the contract.
alter table diagnostic_environment_ownership
    drop constraint diagnostic_environment_ownership_environment_check;
alter table diagnostic_environment_ownership
    add constraint diagnostic_environment_ownership_environment_check
    check (environment in ('localhost', 'development', 'staging', 'production'));

alter table episode_diagnostics
    drop constraint episode_diagnostics_environment_check;
alter table episode_diagnostics
    add constraint episode_diagnostics_environment_check
    check (environment in ('localhost', 'development', 'staging', 'production'));

-- +goose Down

-- Restoring the narrower vocabulary is only valid while no production rows
-- exist; the constraint re-add fails loudly otherwise, which is the correct
-- rollback behavior for a closed allowlist.
alter table diagnostic_environment_ownership
    drop constraint diagnostic_environment_ownership_environment_check;
alter table diagnostic_environment_ownership
    add constraint diagnostic_environment_ownership_environment_check
    check (environment in ('localhost', 'development', 'staging'));

alter table episode_diagnostics
    drop constraint episode_diagnostics_environment_check;
alter table episode_diagnostics
    add constraint episode_diagnostics_environment_check
    check (environment in ('localhost', 'development', 'staging'));
