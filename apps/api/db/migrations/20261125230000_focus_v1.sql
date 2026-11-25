-- +goose Up
-- Focus v1 is a Space setting, off by default. The object leaves room for
-- later renameable product copy without changing the wire or storage shape.
alter table spaces add column focus jsonb not null default '{"enabled":false}'::jsonb;
alter table spaces add constraint spaces_focus_check check (
    jsonb_typeof(focus) = 'object'
    and focus <@ '{"enabled":false}'::jsonb
    and jsonb_typeof(focus -> 'enabled') = 'boolean'
);

-- The three capabilities are part of the closed capability namespace. Owner is
-- the only default bundle that receives them; existing owner rows get the new
-- additive namespace so older Spaces can turn the setting on without manual repair.
create or replace function valid_capabilities(value text[])
returns boolean
language sql
immutable
strict
as $$
    select value <@ array[
        'publishAudio', 'publishVideo', 'publishScreen', 'subscribe',
        'raiseHand', 'renameSelf', 'sendChat', 'sendReaction',
        'drawWhiteboard', 'manageWhiteboard', 'manageAdmission',
        'assignRoles', 'muteOthers', 'stopVideoOthers', 'stopScreenOthers',
        'requestMediaOthers', 'removeParticipant', 'manageRecording',
        'startEpisode', 'extendEpisode', 'endEpisode', 'manageMembers',
        'clearSpaceContent', 'focus.view', 'focus.manage', 'focus.exempt'
    ]::text[]
        and cardinality(value) <= 26
        and cardinality(value) = (select count(distinct capability) from unnest(value) as capability)
$$;

update space_roles
set capabilities = capabilities || array['focus.view', 'focus.manage', 'focus.exempt']::text[],
    updated_at = now()
where name = 'owner'
  and not (capabilities @> array['focus.view', 'focus.manage', 'focus.exempt']::text[]);

-- Reported app states are durable only once they close. A missing or unclosed
-- interval means "not reporting"; it never counts as away time.
create table episode_focus_intervals (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    participant_id uuid not null,
    id uuid not null default gen_random_uuid(),
    state text not null check (state in ('active', 'inactive', 'background')),
    windowed boolean not null,
    started_at timestamptz not null,
    ended_at timestamptz not null,
    created_at timestamptz not null default now(),
    primary key (tenant_id, episode_id, id),
    unique (tenant_id, space_id, episode_id, id),
    foreign key (tenant_id, space_id, episode_id)
        references episodes(tenant_id, space_id, id) on delete restrict,
    foreign key (tenant_id, space_id, episode_id, participant_id)
        references participants(tenant_id, space_id, episode_id, id) on delete restrict,
    check (ended_at > started_at)
);
create index episode_focus_intervals_participant_idx
    on episode_focus_intervals(tenant_id, space_id, episode_id, participant_id, started_at);

create table episode_focus_step_aways (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    participant_id uuid not null,
    actor_participant_id uuid not null,
    id uuid not null default gen_random_uuid(),
    reason text not null check (reason in ('reading', 'notes', 'break')),
    started_at timestamptz not null default now(),
    ended_at timestamptz,
    created_at timestamptz not null default now(),
    primary key (tenant_id, episode_id, id),
    unique (tenant_id, space_id, episode_id, id),
    foreign key (tenant_id, space_id, episode_id)
        references episodes(tenant_id, space_id, id) on delete restrict,
    foreign key (tenant_id, space_id, episode_id, participant_id)
        references participants(tenant_id, space_id, episode_id, id) on delete restrict,
    foreign key (tenant_id, space_id, episode_id, actor_participant_id)
        references participants(tenant_id, space_id, episode_id, id) on delete restrict,
    check (ended_at is null or ended_at >= started_at)
);
create unique index episode_focus_step_aways_one_open_idx
    on episode_focus_step_aways(tenant_id, space_id, episode_id, participant_id)
    where ended_at is null;

create table episode_focus_allow_windows (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    actor_participant_id uuid not null,
    id uuid not null default gen_random_uuid(),
    started_at timestamptz not null default now(),
    ends_at timestamptz not null,
    ended_at timestamptz,
    created_at timestamptz not null default now(),
    primary key (tenant_id, episode_id, id),
    unique (tenant_id, space_id, episode_id, id),
    foreign key (tenant_id, space_id, episode_id)
        references episodes(tenant_id, space_id, id) on delete restrict,
    foreign key (tenant_id, space_id, episode_id, actor_participant_id)
        references participants(tenant_id, space_id, episode_id, id) on delete restrict,
    check (ends_at > started_at),
    check (ended_at is null or ended_at >= started_at)
);
create index episode_focus_allow_windows_episode_idx
    on episode_focus_allow_windows(tenant_id, space_id, episode_id, started_at);

-- +goose Down
drop table episode_focus_allow_windows;
drop table episode_focus_step_aways;
drop table episode_focus_intervals;
alter table spaces drop constraint spaces_focus_check;
alter table spaces drop column focus;
create or replace function valid_capabilities(value text[])
returns boolean
language sql
immutable
strict
as $$
    select value <@ array[
        'publishAudio', 'publishVideo', 'publishScreen', 'subscribe',
        'raiseHand', 'renameSelf', 'sendChat', 'sendReaction',
        'drawWhiteboard', 'manageWhiteboard', 'manageAdmission',
        'assignRoles', 'muteOthers', 'stopVideoOthers', 'stopScreenOthers',
        'requestMediaOthers', 'removeParticipant', 'manageRecording',
        'startEpisode', 'extendEpisode', 'endEpisode', 'manageMembers',
        'clearSpaceContent'
    ]::text[]
        and cardinality(value) <= 23
        and cardinality(value) = (select count(distinct capability) from unnest(value) as capability)
$$;
