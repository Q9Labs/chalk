defmodule ChalkSync.WhiteboardV1.DrawingSQL do
  @moduledoc false

  # The one effective drawing rule. A host is a participant whose role has
  # manageWhiteboard. A per-person row is the host's choice for that person:
  # under everyone it overrides the role default, under picked a true row is
  # the pick, and under hosts it is kept but ignored. Unpicking under picked
  # deletes the row, so it can't turn into a hidden block under everyone.
  def lock_authority, do: drawing_authority() <> " for update of participant"

  def drawing_authority do
    """
    select
      participant.role,
      participant.capabilities,
      case coalesce(policy.policy, 'everyone')
        when 'hosts' then 'manageWhiteboard' = any(participant.capabilities)
        when 'picked' then 'manageWhiteboard' = any(participant.capabilities)
          or coalesce(permission.can_draw, false)
        else coalesce(permission.can_draw, 'drawWhiteboard' = any(participant.capabilities))
      end as can_draw,
      coalesce(policy.policy, 'everyone') as draw_policy,
      participant.name, permission.can_draw as explicit_grant
    from participants participant
    join episodes episode
      on episode.tenant_id = participant.tenant_id
      and episode.space_id = participant.space_id
      and episode.id = participant.episode_id
    left join sync_whiteboard_permissions permission
      on permission.tenant_id = participant.tenant_id
      and permission.space_id = participant.space_id
      and permission.episode_id = participant.episode_id
      and permission.participant_id = participant.id
    left join sync_whiteboard_draw_policies policy
      on policy.tenant_id = participant.tenant_id
      and policy.space_id = participant.space_id
      and policy.episode_id = participant.episode_id
    where participant.tenant_id = $1
      and participant.space_id = $2
      and participant.episode_id = $3
      and participant.id = $4
      and participant.generation = $5
      and participant.status = 'active'
      and episode.status = 'active'
    """
  end

  # The lifecycle state of every current Participant in one Episode, read without a row lock.
  # Left rows are history and count as missing, so the read stays within the Episode's capacity.
end
