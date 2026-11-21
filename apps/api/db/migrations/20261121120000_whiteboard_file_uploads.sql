-- +goose Up
alter table sync_whiteboard_files add column referenced_at timestamptz;
update sync_whiteboard_files set referenced_at = finalized_at where status = 'ready';

create view sync_whiteboard_file_writers as
select participant.tenant_id, participant.space_id, participant.episode_id,
       participant.id as participant_id, participant.generation as participant_generation,
       scene.scene_id
from participants participant
join episodes episode
    on (episode.tenant_id, episode.space_id, episode.id) =
       (participant.tenant_id, participant.space_id, participant.episode_id)
join sync_whiteboard_scenes scene
    on (scene.tenant_id, scene.space_id, scene.episode_id) =
       (participant.tenant_id, participant.space_id, participant.episode_id)
left join sync_whiteboard_permissions permission
    on (permission.tenant_id, permission.space_id, permission.episode_id, permission.participant_id) =
       (participant.tenant_id, participant.space_id, participant.episode_id, participant.id)
left join sync_whiteboard_draw_policies policy
    on (policy.tenant_id, policy.space_id, policy.episode_id) =
       (participant.tenant_id, participant.space_id, participant.episode_id)
where participant.status = 'active' and episode.status = 'active' and scene.is_current
    -- Same effective drawing rule as ChalkSync.WhiteboardV1.SQL.lock_authority/0.
    and case coalesce(policy.policy, 'everyone')
        when 'hosts' then 'manageWhiteboard' = any(participant.capabilities)
        when 'picked' then 'manageWhiteboard' = any(participant.capabilities)
            or coalesce(permission.can_draw, false)
        else coalesce(permission.can_draw, 'drawWhiteboard' = any(participant.capabilities))
    end;

-- +goose Down
drop view sync_whiteboard_file_writers;
alter table sync_whiteboard_files drop column referenced_at;
