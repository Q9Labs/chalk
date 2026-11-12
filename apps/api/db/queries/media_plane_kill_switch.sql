-- name: ReadMediaPlaneKillSwitch :one
select paused from media_plane_kill_switch where singleton;

-- name: LockMediaPlaneKillSwitchForEpisode :one
select paused from media_plane_kill_switch where singleton for share;

-- name: LockMediaPlaneKillSwitchForUpdate :one
select paused from media_plane_kill_switch where singleton for update;

-- name: SetMediaPlaneKillSwitch :exec
update media_plane_kill_switch set paused = $1, updated_at = now() where singleton;

-- name: RecordMediaPlaneKillSwitchChange :exec
insert into media_plane_kill_switch_changes (paused_before, paused_after, operator, reason)
values ($1, $2, $3, $4);
