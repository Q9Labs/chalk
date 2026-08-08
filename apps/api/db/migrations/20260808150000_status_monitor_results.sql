-- +goose Up
create table status_monitor_results (
    result_key text primary key,
    run_id text not null,
    monitor_key text not null,
    status text not null,
    checked_at timestamptz not null,
    event_at timestamptz not null,
    latency_ms bigint not null,
    http_status integer,
    error_code text,
    error_message text,
    response_excerpt text,
    reported_source text not null,
    reported_emitter_id text not null,
    metadata jsonb not null default '{}'::jsonb,
    details jsonb not null default '{}'::jsonb,
    received_at timestamptz not null default now(),
    constraint status_monitor_results_result_key_check check (octet_length(result_key) between 1 and 256),
    constraint status_monitor_results_run_id_check check (octet_length(run_id) between 1 and 128),
    constraint status_monitor_results_monitor_key_check check (octet_length(monitor_key) between 1 and 128),
    constraint status_monitor_results_status_check check (status in ('healthy', 'failed')),
    constraint status_monitor_results_latency_check check (latency_ms between 0 and 120000),
    constraint status_monitor_results_http_status_check check (http_status is null or http_status between 100 and 599),
    constraint status_monitor_results_error_code_check check (error_code is null or octet_length(error_code) <= 512),
    constraint status_monitor_results_error_message_check check (error_message is null or octet_length(error_message) <= 512),
    constraint status_monitor_results_response_excerpt_check check (response_excerpt is null or octet_length(response_excerpt) <= 512),
    constraint status_monitor_results_source_check check (octet_length(reported_source) between 1 and 128),
    constraint status_monitor_results_emitter_check check (octet_length(reported_emitter_id) between 1 and 128),
    constraint status_monitor_results_metadata_check check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 16384),
    constraint status_monitor_results_details_check check (jsonb_typeof(details) = 'object' and octet_length(details::text) <= 16384)
);

create index status_monitor_results_monitor_checked_idx
    on status_monitor_results(monitor_key, checked_at desc, result_key);

create table status_monitor_current (
    monitor_key text primary key,
    result_key text not null references status_monitor_results(result_key) on delete restrict,
    run_id text not null,
    status text not null,
    checked_at timestamptz not null,
    last_changed_at timestamptz not null,
    received_at timestamptz not null,
    constraint status_monitor_current_monitor_key_check check (octet_length(monitor_key) between 1 and 128),
    constraint status_monitor_current_run_id_check check (octet_length(run_id) between 1 and 128),
    constraint status_monitor_current_status_check check (status in ('healthy', 'failed'))
);

-- +goose Down
drop table status_monitor_current;
drop table status_monitor_results;
