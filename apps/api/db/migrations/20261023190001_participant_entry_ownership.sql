-- +goose Up
-- A new completed entry supersedes an older socket's right to Leave the seat.
alter table participant_join_seats add column entry_token_id text
    check (octet_length(entry_token_id) between 1 and 128);

-- +goose Down
alter table participant_join_seats drop column entry_token_id;
