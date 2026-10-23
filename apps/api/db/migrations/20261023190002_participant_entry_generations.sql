-- +goose Up
alter table participant_join_seats
    drop column entry_token_id,
    add column issued_entry_generation bigint not null default 0
        check (issued_entry_generation between 0 and 9007199254740991),
    add column confirmed_entry_generation bigint not null default 0
        check (confirmed_entry_generation between 0 and issued_entry_generation);

-- +goose Down
alter table participant_join_seats
    drop column confirmed_entry_generation,
    drop column issued_entry_generation,
    add column entry_token_id text check (octet_length(entry_token_id) between 1 and 128);
