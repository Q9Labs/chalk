-- +goose Up
alter table sync_whiteboard_scenes
    add column episode_id uuid;

update sync_whiteboard_scenes scene
set episode_id = coalesce(
    scene.presenting_episode_id,
    (
        select element.episode_id
        from sync_whiteboard_elements element
        where element.tenant_id = scene.tenant_id
          and element.space_id = scene.space_id
          and element.scene_id = scene.scene_id
        order by element.updated_at desc, element.episode_id
        limit 1
    ),
    (
        select episode.id
        from episodes episode
        where episode.tenant_id = scene.tenant_id
          and episode.space_id = scene.space_id
        order by episode.created_at desc, episode.id
        limit 1
    )
);

delete from sync_whiteboard_scenes
where episode_id is null;

alter table sync_whiteboard_scenes
    alter column episode_id set not null,
    add constraint sync_whiteboard_scenes_episode_fk
        foreign key (tenant_id, space_id, episode_id)
        references episodes(tenant_id, space_id, id)
        on delete cascade;

drop index sync_whiteboard_scenes_current_idx;
create unique index sync_whiteboard_scenes_current_idx
    on sync_whiteboard_scenes(tenant_id, space_id, episode_id)
    where is_current;

create index sync_chat_messages_episode_sequence_idx
    on sync_chat_messages(tenant_id, space_id, episode_id, sequence);

-- +goose Down
drop index sync_chat_messages_episode_sequence_idx;

with ranked as (
    select tenant_id, space_id, scene_id,
           row_number() over (
               partition by tenant_id, space_id
               order by updated_at desc, scene_id
           ) as position
    from sync_whiteboard_scenes
    where is_current
)
update sync_whiteboard_scenes scene
set is_current = false
from ranked
where scene.tenant_id = ranked.tenant_id
  and scene.space_id = ranked.space_id
  and scene.scene_id = ranked.scene_id
  and ranked.position > 1;

drop index sync_whiteboard_scenes_current_idx;
create unique index sync_whiteboard_scenes_current_idx
    on sync_whiteboard_scenes(tenant_id, space_id)
    where is_current;

alter table sync_whiteboard_scenes
    drop constraint sync_whiteboard_scenes_episode_fk,
    drop column episode_id;
