defmodule ChalkSync.Stateholder.Postgres.ParticipantDevices do
  @moduledoc false
  alias ChalkSync.Database
  alias ChalkSync.Stateholder.Postgres.Scope

  def list(episode) do
    case Postgrex.query(
           Database.connection(episode),
           """
           select p.id, p.generation, p.identity_id, device.device_type,
             (seat->>'admission_revision')::bigint
           from sync_episode_control control
           join episodes e on e.tenant_id=control.tenant_id and e.space_id=control.space_id
             and e.id=control.episode_id
           cross join lateral jsonb_array_elements(control.folded_state->'participants') seat
           join participants p on p.tenant_id=control.tenant_id and p.space_id=control.space_id
             and p.episode_id=control.episode_id and p.id=(seat->>'participant_id')::uuid
           left join participant_device_hints device on device.tenant_id=p.tenant_id
             and device.space_id=p.space_id and device.episode_id=p.episode_id
             and device.participant_id=p.id and device.generation=p.generation
           where control.tenant_id=$1 and control.space_id=$2 and control.episode_id=$3
             and e.status='active' and control.folded_state->>'status'='active'
             and p.status in ('active', 'leaving')
           order by p.id
           """,
           Scope.episode(episode),
           timeout: 1_000
         ) do
      {:ok, %{rows: rows}} ->
        {:ok,
         Enum.map(rows, fn [id, generation, identity_id, device_type, revision] ->
           %{
             participant_id: Scope.nullable_uuid(id),
             generation: generation,
             identity_id: Scope.nullable_uuid(identity_id),
             device_type: device_type,
             admission_revision: revision
           }
         end)}

      {:error, _reason} ->
        {:retryable, :dependency_unavailable}
    end
  rescue
    _exception -> {:retryable, :dependency_unavailable}
  catch
    :exit, _reason -> {:retryable, :dependency_unavailable}
  end
end
