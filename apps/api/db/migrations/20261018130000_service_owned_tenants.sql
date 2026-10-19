-- +goose Up
ALTER TABLE tenants
    ADD COLUMN created_by_service_id text,
    ADD COLUMN external_id text,
    ADD CONSTRAINT tenants_service_id_check CHECK (
        created_by_service_id IS NULL OR (length(created_by_service_id) BETWEEN 1 AND 128 AND btrim(created_by_service_id) = created_by_service_id)
    ),
    ADD CONSTRAINT tenants_external_id_check CHECK (
        external_id IS NULL OR (created_by_service_id IS NOT NULL AND length(external_id) BETWEEN 1 AND 512 AND btrim(external_id) = external_id)
    ),
    ADD CONSTRAINT tenants_service_external_id_key UNIQUE (created_by_service_id, external_id);

CREATE INDEX tenants_service_created_at_id_idx ON tenants(created_by_service_id, created_at DESC, id DESC);

-- +goose Down
-- Dropping the columns would erase which Tenants each service owns, so refuse once any are recorded.
-- The lock stays until the transaction ends, so no writer can record an owner between the check and the drops.
-- +goose StatementBegin
DO $$
BEGIN
    LOCK TABLE tenants IN ACCESS EXCLUSIVE MODE;
    IF EXISTS (SELECT 1 FROM tenants WHERE created_by_service_id IS NOT NULL OR external_id IS NOT NULL) THEN
        RAISE EXCEPTION 'cannot roll back service_owned_tenants: Tenants record a service owner or external_id';
    END IF;
END $$;
-- +goose StatementEnd
DROP INDEX tenants_service_created_at_id_idx;
ALTER TABLE tenants DROP CONSTRAINT tenants_service_external_id_key,
    DROP CONSTRAINT tenants_external_id_check, DROP CONSTRAINT tenants_service_id_check,
    DROP COLUMN external_id, DROP COLUMN created_by_service_id;
