defmodule ChalkSync.Stateholder.Postgres.Scope do
  @moduledoc false

  alias ChalkSync.UUID

  def episode(episode),
    do: [uuid(episode.tenant_id), uuid(episode.space_id), uuid(episode.episode_id)]

  def participant(identity),
    do: episode(identity.episode) ++ [uuid(identity.participant_id)]

  def lifecycle_intent(episode, lifecycle_intent_id),
    do: episode(episode) ++ [uuid(lifecycle_intent_id)]

  def receipt(identity, command) do
    [
      uuid(identity.episode.tenant_id),
      uuid(identity.episode.space_id),
      uuid(identity.episode.episode_id),
      uuid(identity.participant_id),
      command.id
    ]
  end

  def uuid(value), do: UUID.dump!(value)
  def nullable_dump(nil), do: nil
  def nullable_dump(value), do: uuid(value)
  def nullable_uuid(nil), do: nil
  def nullable_uuid(value), do: UUID.load!(value)
end
