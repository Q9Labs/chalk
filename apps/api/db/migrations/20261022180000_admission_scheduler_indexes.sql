-- +goose NO TRANSACTION
-- +goose Up
-- Additive: both the admission fence and older API schedulers keep their schema.
create index concurrently sync_admission_requests_unreserved_deadline_idx
    on sync_admission_requests(expires_at, admission_request_id)
    where status = 'pending' and decision_external_operation_id is null;
-- +goose Down
drop index concurrently if exists sync_admission_requests_unreserved_deadline_idx;
