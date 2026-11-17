-- +goose Up
-- episodes.end_reason now names the real cause, in the vocabulary of Sync's
-- episode_ended event. Rows written with the old words are mapped first.
-- chalk:removed-in #1469
alter table episodes drop constraint episodes_end_reason_check;
update episodes set end_reason = case end_reason
    when 'explicit' then 'ended_by_participant'
    when 'deadline' then 'maximum_duration'
    when 'natural' then 'linger_expired'
end where end_reason is not null;
alter table episodes add constraint episodes_end_reason_check
    check (end_reason in ('ended_by_participant', 'tenant_recovery', 'linger_expired', 'maximum_duration')) not valid;
alter table episodes validate constraint episodes_end_reason_check;

-- +goose Down
alter table episodes drop constraint episodes_end_reason_check;
update episodes set end_reason = case end_reason
    when 'ended_by_participant' then 'explicit'
    when 'tenant_recovery' then 'explicit'
    when 'maximum_duration' then 'deadline'
    when 'linger_expired' then 'natural'
end where end_reason is not null;
alter table episodes add constraint episodes_end_reason_check check (end_reason in ('explicit', 'natural', 'deadline'));
