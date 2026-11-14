-- name: ListRenewableSourceGrants :many
-- The newest confirmed grant of every source in a live Chalk SFU Episode whose
-- authorization still stands, in key order after the cursor. A stop decided at
-- or after the grant ends it whatever its delivery outcome, so a dropped or
-- failed revoke can never be renewed back to life. So does the Participant's
-- departure or the loss of the source's capability. A Leave a newer entry's
-- confirmation superseded is the one exception: a Leave sends nothing to the SFU
-- itself, and Sync marks the superseded one failed with participant_inactive and
-- makes the Participant active again.
select
    grant_row.tenant_id,
    grant_row.episode_id,
    coalesce(episode.config_snapshot->'media_plane_binding'->>'node', '')::text as node,
    coalesce((episode.config_snapshot->'media_plane_binding'->>'generation')::bigint, 0)::bigint as generation,
    grant_row.participant_id,
    grant_row.source,
    grant_row.control_revision::bigint as control_revision
from episodes episode
cross join lateral (
    select distinct on (reservation.participant_id, reservation.source)
        reservation.tenant_id,
        reservation.episode_id,
        reservation.participant_id,
        reservation.participant_generation,
        reservation.source,
        reservation.control_revision
    from sync_publication_grant_reservations reservation
    where reservation.tenant_id = episode.tenant_id
        and reservation.episode_id = episode.id
        and reservation.status = 'confirmed'
        and reservation.control_revision is not null
    order by reservation.participant_id, reservation.source, reservation.control_revision desc
) grant_row
join participants participant
    on participant.tenant_id = grant_row.tenant_id
    and participant.episode_id = grant_row.episode_id
    and participant.id = grant_row.participant_id
    and participant.generation = grant_row.participant_generation
where episode.status = 'active'
    and episode.config_snapshot->'media_plane_binding'->>'provider' = 'chalk_sfu'
    and participant.status = 'active'
    and (case grant_row.source
        when 'microphone' then 'publishAudio'
        when 'camera' then 'publishVideo'
        else 'publishScreen'
    end) = any(participant.capabilities)
    and not exists (
        select 1
        from sync_external_operations stop
        where stop.tenant_id = grant_row.tenant_id
            and stop.episode_id = grant_row.episode_id
            and stop.target_participant_id = grant_row.participant_id
            and stop.control_revision >= grant_row.control_revision
            and not (
                stop.operation_name = 'participant_leave'
                and stop.status = 'failed'
                and stop.last_error_code = 'participant_inactive'
            )
            and (
                stop.operation_name in ('remove_participant', 'participant_leave')
                or (
                    stop.operation_name in (
                        'mute_participant',
                        'stop_participant_camera',
                        'stop_participant_screen_share',
                        'role_transition_source_stop'
                    )
                    and stop.source = grant_row.source
                )
            )
    )
    and (grant_row.tenant_id, grant_row.episode_id, grant_row.participant_id, grant_row.source)
        > (sqlc.arg(after_tenant_id)::uuid, sqlc.arg(after_episode_id)::uuid, sqlc.arg(after_participant_id)::uuid, sqlc.arg(after_source)::text)
order by grant_row.tenant_id, grant_row.episode_id, grant_row.participant_id, grant_row.source
limit sqlc.arg(page_size);
