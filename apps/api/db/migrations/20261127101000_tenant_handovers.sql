-- +goose Up
CREATE TABLE tenant_handovers (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    recipient_email text NOT NULL,
    status text NOT NULL CHECK (status IN ('pending', 'accepted', 'canceled')),
    request_key text NOT NULL,
    request_fingerprint bytea NOT NULL,
    from_service_id text NOT NULL,
    to_service_id text NOT NULL,
    initiated_by_kind text NOT NULL CHECK (initiated_by_kind IN ('service', 'operator')),
    initiated_by_service_id text,
    initiated_by_operator text,
    accepted_by_user_id uuid REFERENCES users(id),
    accepted_at timestamptz,
    canceled_by_kind text CHECK (canceled_by_kind IN ('service', 'operator')),
    canceled_by_service_id text,
    canceled_by_operator text,
    canceled_at timestamptz,
    expires_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, request_key),
    CONSTRAINT tenant_handovers_emails_check CHECK (length(recipient_email) BETWEEN 3 AND 320 AND btrim(recipient_email) = recipient_email),
    CONSTRAINT tenant_handovers_services_check CHECK (
        length(from_service_id) BETWEEN 1 AND 128 AND btrim(from_service_id) = from_service_id
        AND length(to_service_id) BETWEEN 1 AND 128 AND btrim(to_service_id) = to_service_id
    ),
    CONSTRAINT tenant_handovers_initiator_check CHECK (
        (initiated_by_kind = 'service' AND initiated_by_service_id IS NOT NULL AND initiated_by_operator IS NULL)
        OR (initiated_by_kind = 'operator' AND initiated_by_operator IS NOT NULL AND initiated_by_service_id IS NULL)
    ),
    CONSTRAINT tenant_handovers_acceptor_check CHECK ((accepted_at IS NULL) = (accepted_by_user_id IS NULL)),
    CONSTRAINT tenant_handovers_canceler_check CHECK (
        (canceled_at IS NULL) = (canceled_by_kind IS NULL)
        AND (canceled_by_kind IS NULL OR (canceled_by_kind = 'service' AND canceled_by_service_id IS NOT NULL AND canceled_by_operator IS NULL)
        OR (canceled_by_kind = 'operator' AND canceled_by_operator IS NOT NULL AND canceled_by_service_id IS NULL))
    )
);

-- At most one offer can wait for acceptance. Terminal rows stay as the audit record.
CREATE UNIQUE INDEX tenant_handovers_one_pending_idx ON tenant_handovers(tenant_id) WHERE status = 'pending';
CREATE INDEX tenant_handovers_tenant_created_at_id_idx ON tenant_handovers(tenant_id, created_at DESC, id DESC);
CREATE INDEX tenant_handovers_recipient_status_idx ON tenant_handovers(recipient_email, status, created_at DESC);

-- +goose Down
DROP TABLE tenant_handovers;
