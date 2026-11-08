-- +goose Up
-- An Episode's config_snapshot stays immutable except for one move: whole-Episode recovery may
-- replace where a chalk_sfu binding places the Episode (node, incarnation, placement reason and
-- the retired allocations), and only by advancing the binding's generation by exactly one. The
-- trigger is the compare-and-set fence, so no writer can skip a generation or replay an old one.
-- +goose StatementBegin
create or replace function protect_immutable_episode_policy()
returns trigger
language plpgsql
as $$
declare
    old_binding jsonb := old.config_snapshot -> 'media_plane_binding';
    new_binding jsonb := new.config_snapshot -> 'media_plane_binding';
    placement constant text[] := array['node', 'node_incarnation', 'placement_reason', 'generation', 'previous_allocations'];
begin
    if new.config_snapshot is distinct from old.config_snapshot then
        if not coalesce(
            (new.config_snapshot - 'media_plane_binding') = (old.config_snapshot - 'media_plane_binding')
            and jsonb_typeof(old_binding) = 'object'
            and jsonb_typeof(new_binding) = 'object'
            and old_binding ->> 'provider' = 'chalk_sfu'
            and (new_binding - placement) = (old_binding - placement)
            and coalesce((new_binding ->> 'generation')::bigint, 0) = coalesce((old_binding ->> 'generation')::bigint, 0) + 1,
            false
        ) then
            raise exception 'Episode config_snapshot is immutable';
        end if;
    end if;

    if new.deadline_at is distinct from old.deadline_at
        then
        if new.deadline_generation <> old.deadline_generation + 1 then
            raise exception 'Episode deadline mutation must advance generation exactly once';
        end if;
    elsif new.deadline_generation is distinct from old.deadline_generation then
            raise exception 'Episode deadline generation cannot change without a deadline mutation';
    end if;

    return new;
end;
$$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
create or replace function protect_immutable_episode_policy()
returns trigger
language plpgsql
as $$
begin
    if new.config_snapshot is distinct from old.config_snapshot then
        raise exception 'Episode config_snapshot is immutable';
    end if;

    if new.deadline_at is distinct from old.deadline_at
        then
        if new.deadline_generation <> old.deadline_generation + 1 then
            raise exception 'Episode deadline mutation must advance generation exactly once';
        end if;
    elsif new.deadline_generation is distinct from old.deadline_generation then
            raise exception 'Episode deadline generation cannot change without a deadline mutation';
    end if;

    return new;
end;
$$;
-- +goose StatementEnd
